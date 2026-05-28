import { BrowserContext } from 'playwright';
import {
  MarketArtifactMetadata,
  MarketResearchConfig,
  MarketResearchTarget,
} from '../types';
import {
  resolveFirstMarketQuery,
  resolveMarketPrimaryUrl,
} from '../config/marketResearchConfig';
import {
  createMarketArtifactPaths,
  saveMarketErrorArtifacts,
  saveMarketSuccessArtifacts,
  toMarketArtifactErrorInfo,
} from '../utils/marketArtifacts';
import {
  createMarketOutputPaths,
  getMarketOutputFiles,
  normalizeMarketOutputFormats,
  writeMarketOutputs,
} from '../utils/marketOutput';

export interface MarketSmokeResult {
  artifactDir: string;
  outputFiles: string[];
  metadata: MarketArtifactMetadata;
}

interface MarketSmokeOptions {
  headless: boolean;
  runAt?: Date;
  artifactRootDir?: string;
  outputDir?: string;
}

export async function scrapeMarketSmoke(
  context: BrowserContext,
  config: MarketResearchConfig,
  options: MarketSmokeOptions,
): Promise<MarketSmokeResult> {
  const target: MarketResearchTarget = 'market-smoke';
  const runAt = options.runAt ?? new Date();
  const outputFormats = normalizeMarketOutputFormats(config.outputFormats);
  const outputPaths = await createMarketOutputPaths(target, runAt, options.outputDir);
  const artifactPaths = createMarketArtifactPaths(config.project, target, runAt, options.artifactRootDir);
  const url = resolveMarketPrimaryUrl(config);
  const query = resolveFirstMarketQuery(config);
  const page = await context.newPage();
  let finalUrl = url;

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    finalUrl = page.url() || url;

    const bodyText = await readBodyText(page);
    const blocked = isLikelyBlocked(response?.status() ?? null, bodyText);
    const metadata = buildMetadata({
      config,
      target,
      query,
      url,
      finalUrl,
      crawledAt: runAt.toISOString(),
      headless: options.headless,
      blocked,
    });

    await saveMarketSuccessArtifacts(page, artifactPaths, metadata);
    await writeMarketOutputs(outputPaths, outputFormats, [buildOutputRecord(metadata)]);

    console.log(`[Market] smoke 完了: ${finalUrl}`);
    console.log(`[Market] 出力: ${getMarketOutputFiles(outputPaths, outputFormats).join(', ')}`);
    console.log(`[Market] 証跡: ${artifactPaths.artifactDir}`);

    return {
      artifactDir: artifactPaths.artifactDir,
      outputFiles: getMarketOutputFiles(outputPaths, outputFormats),
      metadata,
    };
  } catch (error) {
    finalUrl = page.url() || finalUrl;

    const bodyText = await readBodyText(page);
    const blocked = isLikelyBlocked(null, bodyText) || isLikelyBlockedByError(error);
    const metadata = buildMetadata({
      config,
      target,
      query,
      url,
      finalUrl,
      crawledAt: runAt.toISOString(),
      headless: options.headless,
      blocked,
      error: toMarketArtifactErrorInfo(error),
    });

    await saveMarketErrorArtifacts(page, artifactPaths, metadata);
    await writeMarketOutputs(outputPaths, outputFormats, [buildOutputRecord(metadata)]).catch(() => undefined);

    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}

function buildMetadata(params: {
  config: MarketResearchConfig;
  target: MarketResearchTarget;
  query: string | null;
  url: string;
  finalUrl: string;
  crawledAt: string;
  headless: boolean;
  blocked: boolean;
  error?: MarketArtifactMetadata['error'];
}): MarketArtifactMetadata {
  return {
    project: params.config.project,
    target: params.target,
    query: params.query,
    url: params.url,
    finalUrl: params.finalUrl,
    crawledAt: params.crawledAt,
    locale: params.config.locale,
    timezone: params.config.timezone,
    viewport: params.config.viewport,
    headless: params.headless,
    loginStateLabel: params.config.loginStateLabel ?? 'anonymous',
    profileName: params.config.profileName ?? null,
    blocked: params.blocked,
    error: params.error ?? null,
  };
}

function buildOutputRecord(metadata: MarketArtifactMetadata): Record<string, unknown> {
  return {
    project: metadata.project,
    target: metadata.target,
    query: metadata.query,
    url: metadata.url,
    finalUrl: metadata.finalUrl,
    crawledAt: metadata.crawledAt,
    locale: metadata.locale,
    timezone: metadata.timezone,
    viewport: metadata.viewport,
    headless: metadata.headless,
    loginStateLabel: metadata.loginStateLabel,
    profileName: metadata.profileName,
    blocked: metadata.blocked,
    errorName: metadata.error?.name ?? '',
    errorMessage: metadata.error?.message ?? '',
    errorStack: metadata.error?.stack ?? '',
    error: metadata.error,
  };
}

async function readBodyText(page: import('playwright').Page): Promise<string> {
  try {
    return (await page.textContent('body')) ?? '';
  } catch {
    return '';
  }
}

function isLikelyBlocked(status: number | null, bodyText: string): boolean {
  if (status === 403 || status === 429) {
    return true;
  }

  const normalized = bodyText.toLowerCase();
  return [
    'captcha',
    'not a robot',
    'access denied',
    'verify you are human',
    'robot',
    'blocked',
  ].some((pattern) => normalized.includes(pattern));
}

function isLikelyBlockedByError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    'captcha',
    'access denied',
    'blocked',
    '403',
    '429',
  ].some((pattern) => message.includes(pattern));
}