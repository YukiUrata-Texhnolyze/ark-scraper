import { Page } from 'playwright';
import { MarketArtifactMetadata, MarketResearchConfig, MarketResearchTarget } from '../types';

export function buildMarketArtifactMetadata(params: {
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

export async function readMarketPageBodyText(page: Page): Promise<string> {
  try {
    return (await page.textContent('body')) ?? '';
  } catch {
    return '';
  }
}

export function isLikelyBlocked(status: number | null, bodyText: string): boolean {
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

export function isLikelyBlockedByError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    'captcha',
    'access denied',
    'blocked',
    '403',
    '429',
  ].some((pattern) => message.includes(pattern));
}