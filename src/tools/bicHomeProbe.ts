import 'dotenv/config';
import dns from 'dns/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, Page } from 'playwright';
import {
  BIC_DEFAULT_HEADERS,
  BIC_HOME_URL,
  buildBicLaunchOptions,
  buildBicPersistentContextOptions,
  DEFAULT_BIC_PROFILE_DIR,
  resolveBicBrowserChannel,
  resolveBicDisableHttp2,
  resolveBicPersistentUserDataDir,
} from '../utils/bicBrowser';
import { formatMarketTimestamp } from '../utils/marketOutput';
import { DEFAULT_RETENTION_KEEP_COUNT, pruneTimestampedChildDirectories } from '../utils/retention';

interface CliOptions {
  url: string;
  outputDir?: string;
  timeoutMs: number;
  pauseMs: number;
  bodyChars: number;
  persistent: boolean;
}

async function main(): Promise<void> {
  const options = getCliOptions();
  const runAt = new Date();
  const headless = process.env.HEADLESS === 'true';
  const channel = resolveBicBrowserChannel();
  const disableHttp2 = resolveBicDisableHttp2();
  const artifactDir = path.resolve(
    options.outputDir ?? path.join('playwright-artifacts', 'bic-home-probe', formatMarketTimestamp(runAt)),
  );
  const userDataDir = options.persistent
    ? path.resolve(resolveBicPersistentUserDataDir() ?? DEFAULT_BIC_PROFILE_DIR)
    : null;

  await fs.promises.mkdir(artifactDir, { recursive: true });
  await pruneTimestampedChildDirectories(path.dirname(artifactDir), DEFAULT_RETENTION_KEEP_COUNT);

  const probeUrl = new URL(options.url);
  const dnsInfo = await collectDnsInfo(probeUrl.hostname);

  let closeBrowser = async (): Promise<void> => undefined;

  try {
    const context = options.persistent
      ? await chromium.launchPersistentContext(userDataDir!, buildBicPersistentContextOptions(headless))
      : await launchFreshContext(headless);

    closeBrowser = async () => context.close().catch(() => undefined);

    const page = context.pages()[0] ?? await context.newPage();
    await primeBicPage(page);

    let responseHeaders: Record<string, string> | null = null;
    let responseStatus: number | null = null;
    let responseStatusText: string | null = null;
    let error: { name: string; message: string } | null = null;

    try {
      const response = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs,
      });
      responseStatus = response?.status() ?? null;
      responseStatusText = response?.statusText() ?? null;
      responseHeaders = sanitizeHeaders(response?.headers() ?? null);
      await page.waitForTimeout(options.pauseMs).catch(() => undefined);
    } catch (caughtError) {
      error = toErrorInfo(caughtError);
    }

    const title = await page.title().catch(() => '');
    const bodyText = normalizeWhitespace((await page.textContent('body').catch(() => '')) ?? '');
    const pageHtml = await page.content().catch(() => '');
    const cookies = await context.cookies().catch(() => []);
    const navigatorState = await page.evaluate(() => {
      const userAgentData = (navigator as Navigator & {
        userAgentData?: {
          brands?: Array<{ brand: string; version: string }>;
          mobile?: boolean;
          platform?: string;
        };
      }).userAgentData;

      return {
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        platform: navigator.platform,
        vendor: navigator.vendor,
        webdriver: (navigator as Navigator & { webdriver?: boolean }).webdriver ?? null,
        hardwareConcurrency: navigator.hardwareConcurrency,
        cookieEnabled: navigator.cookieEnabled,
        onLine: navigator.onLine,
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
        userAgentData: userAgentData
          ? {
              brands: userAgentData.brands ?? null,
              mobile: userAgentData.mobile ?? null,
              platform: userAgentData.platform ?? null,
            }
          : null,
      };
    }).catch(() => null);

    await page.screenshot({
      path: path.join(artifactDir, 'screenshot.png'),
      fullPage: true,
    }).catch(() => undefined);

    await fs.promises.writeFile(path.join(artifactDir, 'page.html'), pageHtml, 'utf8');

    const result = {
      runAt: runAt.toISOString(),
      artifactDir,
      probeUrl: options.url,
      finalUrl: page.url(),
      title,
      httpStatus: responseStatus,
      httpStatusText: responseStatusText,
      error,
      launch: {
        persistent: options.persistent,
        userDataDir,
        headless,
        channel: channel ?? null,
        disableHttp2,
      },
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        node: process.version,
      },
      dns: dnsInfo,
      proxyEnv: readProxyEnv(),
      responseHeaders,
      navigator: navigatorState,
      cookies: {
        count: cookies.length,
        names: Array.from(new Set(cookies.map((cookie) => cookie.name))).sort(),
      },
      bodySnippet: bodyText.slice(0, options.bodyChars),
    };

    await fs.promises.writeFile(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

    console.log(`[Bic Probe] artifact: ${artifactDir}`);
    console.log(`[Bic Probe] url: ${result.finalUrl}`);
    console.log(`[Bic Probe] title: ${result.title || '(empty)'}`);
    console.log(`[Bic Probe] status: ${String(result.httpStatus ?? 'null')}${result.httpStatusText ? ` ${result.httpStatusText}` : ''}`);
    if (result.error) {
      console.log(`[Bic Probe] error: ${result.error.name}: ${result.error.message}`);
    }
    console.log(`[Bic Probe] cookies: ${result.cookies.count}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeBrowser();
  }
}

async function launchFreshContext(headless: boolean) {
  const browser = await chromium.launch(buildBicLaunchOptions(headless));
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1920, height: 1080 },
    colorScheme: 'light',
  });

  const originalClose = context.close.bind(context);
  context.close = async () => {
    await originalClose().catch(() => undefined);
    await browser.close().catch(() => undefined);
  };

  return context;
}

async function collectDnsInfo(hostname: string) {
  const lookup = await dns.lookup(hostname, { all: true }).then(
    (records) => records.map((record) => ({ address: record.address, family: record.family })),
    (error: Error) => ({ error: error.message }),
  );
  const resolve4 = await dns.resolve4(hostname).then(
    (records) => records,
    (error: Error) => ({ error: error.message }),
  );
  const resolve6 = await dns.resolve6(hostname).then(
    (records) => records,
    (error: Error) => ({ error: error.message }),
  );

  return {
    hostname,
    lookup,
    resolve4,
    resolve6,
  };
}

function getCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  let url = BIC_HOME_URL;
  let outputDir: string | undefined;
  let timeoutMs = 60000;
  let pauseMs = 3000;
  let bodyChars = 600;
  let persistent = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = args[index + 1];

    if ((arg === '--url' || arg === '--output-dir' || arg === '--timeout-ms' || arg === '--pause-ms' || arg === '--body-chars') && (!nextValue || nextValue.startsWith('--'))) {
      throw new Error(`${arg} には値が必要です`);
    }

    if (arg === '--url') {
      url = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      outputDir = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      timeoutMs = Number(nextValue);
      index += 1;
      continue;
    }

    if (arg === '--pause-ms') {
      pauseMs = Number(nextValue);
      index += 1;
      continue;
    }

    if (arg === '--body-chars') {
      bodyChars = Number(nextValue);
      index += 1;
      continue;
    }

    if (arg === '--fresh') {
      persistent = false;
      continue;
    }

    if (arg === '--persistent') {
      persistent = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`不正なオプション: ${arg}`);
    }
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms は正の数値で指定してください');
  }

  if (!Number.isFinite(pauseMs) || pauseMs < 0) {
    throw new Error('--pause-ms は 0 以上の数値で指定してください');
  }

  if (!Number.isFinite(bodyChars) || bodyChars <= 0) {
    throw new Error('--body-chars は正の数値で指定してください');
  }

  return {
    url,
    outputDir,
    timeoutMs,
    pauseMs,
    bodyChars,
    persistent,
  };
}

async function primeBicPage(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders(BIC_DEFAULT_HEADERS).catch(() => undefined);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readProxyEnv(): Record<string, string | null> {
  return {
    HTTP_PROXY: sanitizeProxyValue(process.env.HTTP_PROXY),
    HTTPS_PROXY: sanitizeProxyValue(process.env.HTTPS_PROXY),
    ALL_PROXY: sanitizeProxyValue(process.env.ALL_PROXY),
    NO_PROXY: process.env.NO_PROXY ?? null,
    http_proxy: sanitizeProxyValue(process.env.http_proxy),
    https_proxy: sanitizeProxyValue(process.env.https_proxy),
    all_proxy: sanitizeProxyValue(process.env.all_proxy),
    no_proxy: process.env.no_proxy ?? null,
  };
}

function sanitizeProxyValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const authPrefix = parsed.username || parsed.password ? '***@' : '';
    return `${parsed.protocol}//${authPrefix}${parsed.host}`;
  } catch {
    return value;
  }
}

function sanitizeHeaders(headers: Record<string, string> | null): Record<string, string> | null {
  if (!headers) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !['set-cookie', 'cookie', 'authorization'].includes(key.toLowerCase())),
  );
}

function toErrorInfo(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

main().catch((error) => {
  console.error('[Bic Probe] エラー:', error);
  process.exit(1);
});