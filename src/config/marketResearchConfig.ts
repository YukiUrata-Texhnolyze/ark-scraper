import fs from 'fs';
import path from 'path';
import {
  MarketOutputFormat,
  MarketResearchConfig,
  MarketResearchProjectConfig,
  MarketResearchQueryGroups,
  MarketResearchViewport,
} from '../types';

const DEFAULT_MARKET_VIEWPORT: MarketResearchViewport = {
  width: 1920,
  height: 1080,
};

const DEFAULT_MARKET_OUTPUT_FORMATS: MarketOutputFormat[] = ['csv', 'jsonl'];
const VALID_OUTPUT_FORMATS = new Set<MarketOutputFormat>(DEFAULT_MARKET_OUTPUT_FORMATS);

export interface LoadedMarketResearchConfig {
  configPath: string;
  config: MarketResearchConfig;
}

export async function loadMarketResearchConfig(cliConfigPath?: string): Promise<LoadedMarketResearchConfig> {
  const configPath = resolveMarketResearchConfigPath(cliConfigPath);
  if (!configPath) {
    throw new Error('market-* target では --config または MARKET_RESEARCH_CONFIG_PATH の指定が必要です');
  }

  const resolvedPath = path.resolve(configPath);
  const raw = await fs.promises.readFile(resolvedPath, 'utf8').catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[market-config] 読み込み失敗: ${resolvedPath} (${message})`);
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[market-config] JSON parse 失敗: ${resolvedPath} (${message})`);
  }

  return {
    configPath: resolvedPath,
    config: normalizeMarketResearchConfig(parsed, resolvedPath),
  };
}

export function resolveMarketResearchConfigPath(cliConfigPath?: string): string | undefined {
  const fromCli = cliConfigPath?.trim();
  if (fromCli) {
    return fromCli;
  }

  const fromEnv = process.env.MARKET_RESEARCH_CONFIG_PATH?.trim();
  return fromEnv || undefined;
}

export function resolveMarketHeadless(config: MarketResearchConfig, defaultHeadless: boolean): boolean {
  const envValue = process.env.HEADLESS?.trim().toLowerCase();
  if (envValue) {
    return !['0', 'false', 'no', 'off'].includes(envValue);
  }

  if (typeof config.headless === 'boolean') {
    return config.headless;
  }

  return defaultHeadless;
}

export function resolveMarketPrimaryUrl(config: MarketResearchProjectConfig): string {
  return resolveMarketOfficialUrls(config)[0];
}

export function resolveMarketOfficialUrls(config: MarketResearchProjectConfig): string[] {
  const urls = config.officialUrls
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) ?? [];

  if (urls.length === 0) {
    throw new Error('[market-config] officialUrls に少なくとも1件のURLを設定してください');
  }

  return urls;
}

export function resolveFirstMarketQuery(config: MarketResearchProjectConfig): string | null {
  if (!config.queries) {
    return null;
  }

  for (const values of Object.values(config.queries)) {
    const query = values?.find((entry) => entry.trim().length > 0);
    if (query) {
      return query;
    }
  }

  return null;
}

function normalizeMarketResearchConfig(value: unknown, resolvedPath: string): MarketResearchConfig {
  if (!isRecord(value)) {
    throw new Error(`[market-config] JSON object を指定してください: ${resolvedPath}`);
  }

  return {
    project: readRequiredString(value.project, 'project', resolvedPath),
    locale: readOptionalString(value.locale) ?? 'ja-JP',
    timezone: readOptionalString(value.timezone) ?? 'Asia/Tokyo',
    viewport: normalizeViewport(value.viewport),
    headless: typeof value.headless === 'boolean' ? value.headless : undefined,
    officialUrls: normalizeStringArray(value.officialUrls),
    queries: normalizeQueries(value.queries),
    loginStateLabel: readOptionalString(value.loginStateLabel) ?? 'anonymous',
    profileName: value.profileName === null ? null : readOptionalString(value.profileName) ?? null,
    outputFormats: normalizeOutputFormats(value.outputFormats),
  };
}

function normalizeViewport(value: unknown): MarketResearchViewport {
  if (!isRecord(value)) {
    return { ...DEFAULT_MARKET_VIEWPORT };
  }

  const width = normalizePositiveNumber(value.width, DEFAULT_MARKET_VIEWPORT.width);
  const height = normalizePositiveNumber(value.height, DEFAULT_MARKET_VIEWPORT.height);

  return { width, height };
}

function normalizeQueries(value: unknown): MarketResearchQueryGroups | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: MarketResearchQueryGroups = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const entries = normalizeStringArray(rawValue);
    if (entries && entries.length > 0) {
      normalized[key] = entries;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeOutputFormats(value: unknown): MarketOutputFormat[] {
  const normalized = normalizeStringArray(value)
    ?.map((entry) => entry as MarketOutputFormat)
    .filter((entry) => VALID_OUTPUT_FORMATS.has(entry));

  if (!normalized || normalized.length === 0) {
    return [...DEFAULT_MARKET_OUTPUT_FORMATS];
  }

  return Array.from(new Set(normalized));
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function readRequiredString(value: unknown, fieldName: string, resolvedPath: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new Error(`[market-config] ${fieldName} は必須です: ${resolvedPath}`);
  }

  return normalized;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.round(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}