import { BrowserContextOptions, LaunchOptions } from 'playwright';
import { MarketResearchConfig } from '../types';

type PersistentContextLaunchOptions = BrowserContextOptions & LaunchOptions;

export const DEFAULT_BIC_PROFILE_DIR = './.playwright/profiles/bic-research';
export const BIC_HOME_URL = 'https://www.biccamera.com/bc/main/';
export const BIC_SEARCH_BASE_URL = 'https://www.biccamera.com/bc/category/';

export function buildBicSearchUrl(query: string): string {
  const url = new URL(BIC_SEARCH_BASE_URL);
  url.searchParams.set('q', query);
  return url.toString();
}

export function resolveBicPersistentUserDataDir(): string | undefined {
  const value = process.env.BIC_PERSISTENT_USER_DATA_DIR?.trim();
  return value ? value : undefined;
}

export function resolveBicBrowserChannel(): string | undefined {
  const value = process.env.BIC_BROWSER_CHANNEL?.trim();
  return value ? value : undefined;
}

export function resolveBicDisableHttp2(): boolean {
  const rawValue = process.env.BIC_DISABLE_HTTP2;
  if (!rawValue) {
    return false;
  }

  return !['0', 'false', 'no', 'off'].includes(rawValue.toLowerCase());
}

export function buildBaseChromiumArgs(extraArgs: string[] = []): string[] {
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];

  for (const arg of extraArgs) {
    if (!args.includes(arg)) {
      args.push(arg);
    }
  }

  return args;
}

export function buildDefaultChromiumLaunchOptions(headless: boolean): LaunchOptions {
  return {
    headless,
    args: buildBaseChromiumArgs(),
  };
}

export function buildBicLaunchOptions(headless: boolean): LaunchOptions {
  const channel = resolveBicBrowserChannel();
  const args = buildBaseChromiumArgs(resolveBicDisableHttp2() ? ['--disable-http2'] : []);

  return {
    headless,
    args,
    ...(channel ? { channel } : {}),
  };
}

export function buildMarketContextOptions(config: MarketResearchConfig): BrowserContextOptions {
  return {
    locale: config.locale,
    timezoneId: config.timezone,
    viewport: config.viewport,
    colorScheme: 'light',
  };
}

export function buildBicPersistentContextOptions(
  headless: boolean,
  config?: Pick<MarketResearchConfig, 'locale' | 'timezone' | 'viewport'>,
): PersistentContextLaunchOptions {
  return {
    ...buildBicLaunchOptions(headless),
    locale: config?.locale ?? 'ja-JP',
    timezoneId: config?.timezone ?? 'Asia/Tokyo',
    viewport: config?.viewport ?? { width: 1920, height: 1080 },
    colorScheme: 'light',
  };
}