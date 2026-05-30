import { BrowserContext, Page } from 'playwright';
import {
  BicSearchCandidate,
  BicSearchPageData,
  parseBicSearchDocument,
} from '../parsers/bicSearchParser';
import { resolveMarketBicQueries } from '../config/marketResearchConfig';
import { MarketArtifactMetadata, MarketResearchConfig } from '../types';
import {
  createMarketArtifactPaths,
  saveMarketErrorArtifacts,
  saveMarketSuccessArtifacts,
  toMarketArtifactErrorInfo,
} from '../utils/marketArtifacts';
import {
  buildMarketArtifactMetadata,
  isBrowserInternalErrorPage,
  isLikelyBlocked,
  isLikelyBlockedByError,
  isLikelyTransportError,
  readMarketPageBodyText,
} from '../utils/marketPage';
import { BIC_DEFAULT_HEADERS, BIC_HOME_URL, buildBicSearchUrl } from '../utils/bicBrowser';
import {
  createMarketOutputPaths,
  getMarketOutputFiles,
  normalizeMarketOutputFormats,
  writeMarketOutputs,
} from '../utils/marketOutput';

type MarketBicSearchStatus = 'ok' | 'no_results' | 'blocked' | 'transport_error' | 'error';

export interface MarketBicSearchRecord {
  project: string;
  source: 'bic';
  target: 'market-bic-search';
  query: string;
  rank: number | null;
  title: string | null;
  price: string | null;
  pointLabel: string | null;
  stockLabel: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  categoryLabel: string | null;
  searchUrl: string;
  finalUrl: string;
  status: MarketBicSearchStatus;
  blocked: boolean;
  crawledAt: string;
  artifactDir: string;
  errorName: string | null;
  errorMessage: string | null;
}

export interface MarketBicSearchResult {
  artifactDirs: string[];
  outputFiles: string[];
  records: MarketBicSearchRecord[];
}

export interface MarketBicSearchOptions {
  headless: boolean;
  runAt?: Date;
  artifactRootDir?: string;
  outputDir?: string;
  timeoutMs?: number;
  maxResults?: number;
}

type MarketBicSearchArtifactMetadata = MarketArtifactMetadata & {
  source: 'bic';
  searchUrl: string;
  httpStatus: number | null;
  status: MarketBicSearchStatus;
  artifactDir: string;
  resultCount: number;
  title: string | null;
};

const TARGET = 'market-bic-search' as const;
const SOURCE = 'bic' as const;
const DEFAULT_MAX_RESULTS = 20;
const MAX_PAGE_OPEN_ATTEMPTS = 2;
const RETRY_DELAY_MS = 3000;
const PAGE_WAIT_MS = 1500;

export async function scrapeMarketBicSearch(
  context: BrowserContext,
  config: MarketResearchConfig,
  options: MarketBicSearchOptions,
): Promise<MarketBicSearchResult> {
  const runAt = options.runAt ?? new Date();
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const queries = resolveMarketBicQueries(config);
  const outputFormats = normalizeMarketOutputFormats(config.outputFormats);
  const outputPaths = await createMarketOutputPaths(TARGET, runAt, options.outputDir);
  const artifactDirs: string[] = [];
  const records: MarketBicSearchRecord[] = [];

  const preflight = await preflightBicSession(context, timeoutMs);
  if (preflight.status === 'blocked' || preflight.status === 'transport_error') {
    console.warn(
      `[Market] bic-search preflight status=${preflight.status} title=${preflight.title || '(empty)'}; query 巡回を中止します`,
    );

    await writeMarketOutputs(outputPaths, outputFormats, []);
    const outputFiles = getMarketOutputFiles(outputPaths, outputFormats);
    console.log('[Market] bic-search 完了: ok=0 no_results=0 blocked=0 transport_error=0 error=0');
    console.log(`[Market] 出力: ${outputFiles.join(', ')}`);

    return {
      artifactDirs,
      outputFiles,
      records,
    };
  }

  for (const [index, query] of queries.entries()) {
    const searchUrl = buildBicSearchUrl(query);
    const artifactPaths = createMarketArtifactPaths(
      config.project,
      TARGET,
      runAt,
      options.artifactRootDir,
      buildQueryArtifactLabel(query, index),
    );

    artifactDirs.push(artifactPaths.artifactDir);

    const queryResult = await crawlBicSearchQuery(context, config, {
      query,
      searchUrl,
      artifactPaths,
      headless: options.headless,
      crawledAt: runAt.toISOString(),
      timeoutMs,
      maxResults,
    });

    records.push(...queryResult.records);

    if (queryResult.records.every((record) => record.status === 'blocked' || record.status === 'transport_error')) {
      console.warn(`[Market] bic-search query="${query}" status=${queryResult.records[0]?.status ?? 'unknown'}; 残り query を中止します`);
      break;
    }
  }

  await writeMarketOutputs(
    outputPaths,
    outputFormats,
    records.map((record) => ({ ...record })),
  );

  const summary = summarizeStatuses(records);
  const outputFiles = getMarketOutputFiles(outputPaths, outputFormats);

  console.log(
    `[Market] bic-search 完了: ok=${summary.ok} no_results=${summary.no_results} blocked=${summary.blocked} transport_error=${summary.transport_error} error=${summary.error}`,
  );
  console.log(`[Market] 出力: ${outputFiles.join(', ')}`);

  return {
    artifactDirs,
    outputFiles,
    records,
  };
}

async function crawlBicSearchQuery(
  context: BrowserContext,
  config: MarketResearchConfig,
  params: {
    query: string;
    searchUrl: string;
    artifactPaths: ReturnType<typeof createMarketArtifactPaths>;
    headless: boolean;
    crawledAt: string;
    timeoutMs: number;
    maxResults: number;
  },
): Promise<{ records: MarketBicSearchRecord[] }> {
  for (let attempt = 1; attempt <= MAX_PAGE_OPEN_ATTEMPTS; attempt += 1) {
    const page = await context.newPage();
    let httpStatus: number | null = null;
    let finalUrl = params.searchUrl;

    try {
      await primeBicPage(page);
      const response = await navigateBicSearch(page, params.query, params.timeoutMs);
      httpStatus = response?.status() ?? null;

      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(PAGE_WAIT_MS).catch(() => undefined);
      finalUrl = page.url() || params.searchUrl;

      const blockState = await readBicBlockState(page, httpStatus);
      if (blockState.blocked) {
        const metadata = buildArtifactMetadata({
          config,
          query: params.query,
          searchUrl: params.searchUrl,
          finalUrl,
          crawledAt: params.crawledAt,
          headless: params.headless,
          blocked: true,
          httpStatus,
          status: 'blocked',
          artifactDir: params.artifactPaths.artifactDir,
          title: blockState.title || null,
          resultCount: 0,
        });

        await saveMarketSuccessArtifacts(page, params.artifactPaths, metadata);
        return {
          records: [buildPlaceholderRecord({
            project: config.project,
            query: params.query,
            searchUrl: params.searchUrl,
            finalUrl,
            status: 'blocked',
            blocked: true,
            crawledAt: params.crawledAt,
            artifactDir: params.artifactPaths.artifactDir,
          })],
        };
      }

      const pageData = await extractBicSearchResults(page, params.maxResults);
      const status: MarketBicSearchStatus = pageData.noResults || pageData.items.length === 0 ? 'no_results' : 'ok';
      const metadata = buildArtifactMetadata({
        config,
        query: params.query,
        searchUrl: params.searchUrl,
        finalUrl,
        crawledAt: params.crawledAt,
        headless: params.headless,
        blocked: false,
        httpStatus,
        status,
        artifactDir: params.artifactPaths.artifactDir,
        title: pageData.pageTitle,
        resultCount: pageData.items.length,
      });
      await saveMarketSuccessArtifacts(page, params.artifactPaths, metadata);

      if (status === 'no_results') {
        return {
          records: [buildPlaceholderRecord({
            project: config.project,
            query: params.query,
            searchUrl: params.searchUrl,
            finalUrl,
            status: 'no_results',
            blocked: false,
            crawledAt: params.crawledAt,
            artifactDir: params.artifactPaths.artifactDir,
          })],
        };
      }

      return {
        records: pageData.items.map((item) => buildResultRecord({
          project: config.project,
          query: params.query,
          searchUrl: params.searchUrl,
          finalUrl,
          item,
          crawledAt: params.crawledAt,
          artifactDir: params.artifactPaths.artifactDir,
        })),
      };
    } catch (error) {
      const errorInfo = toMarketArtifactErrorInfo(error);
      const finalAttempt = attempt === MAX_PAGE_OPEN_ATTEMPTS;

      if (!finalAttempt) {
        console.warn(`[Market] bic-search query="${params.query}" retry ${attempt}/${MAX_PAGE_OPEN_ATTEMPTS}: ${errorInfo.message}`);
        await page.close().catch(() => undefined);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      finalUrl = page.url() || finalUrl;
      const blockState = await readBicBlockState(page, httpStatus).catch(() => ({
        blocked: false,
        title: '',
        bodyText: '',
      }));
      const blocked = blockState.blocked || isLikelyBicBlockedByError(error);
      const transportError = !blocked && isLikelyTransportError(error);
      const status: MarketBicSearchStatus = blocked ? 'blocked' : transportError ? 'transport_error' : 'error';
      const metadata = buildArtifactMetadata({
        config,
        query: params.query,
        searchUrl: params.searchUrl,
        finalUrl,
        crawledAt: params.crawledAt,
        headless: params.headless,
        blocked,
        httpStatus,
        status,
        artifactDir: params.artifactPaths.artifactDir,
        title: blockState.title || null,
        resultCount: 0,
        error: errorInfo,
      });

      await saveMarketErrorArtifacts(page, params.artifactPaths, metadata);

      return {
        records: [buildPlaceholderRecord({
          project: config.project,
          query: params.query,
          searchUrl: params.searchUrl,
          finalUrl,
          status,
          blocked,
          crawledAt: params.crawledAt,
          artifactDir: params.artifactPaths.artifactDir,
          errorName: errorInfo.name ?? null,
          errorMessage: errorInfo.message,
        })],
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  return { records: [] };
}

async function extractBicSearchResults(page: Page, maxResults: number): Promise<BicSearchPageData> {
  return page.evaluate(parseBicSearchDocument, {
    baseUrl: page.url() || BIC_HOME_URL,
    maxResults,
  });
}

async function readBicBlockState(page: Page, status: number | null): Promise<{ blocked: boolean; title: string; bodyText: string }> {
  const currentUrl = page.url() || '';
  const title = normalizeBicText(await page.title().catch(() => ''));
  const bodyText = normalizeBicText(await readMarketPageBodyText(page));

  if (isBrowserInternalErrorPage(currentUrl)) {
    return {
      blocked: status === 403 || status === 429,
      title,
      bodyText,
    };
  }

  const normalized = `${title}\n${bodyText}`.toLowerCase();
  const blocked = isLikelyBlocked(status, bodyText) || [
    'powered and protected by',
    'access denied',
    'forbidden',
    'captcha',
    'not a robot',
    '通信に問題があるためアクセスを遮断しました。',
    'アクセスが集中',
    'しばらくしてから再度アクセスしてください',
    '不正なアクセス',
    'ご利用の環境',
  ].some((pattern) => normalized.includes(pattern.toLowerCase()));

  return {
    blocked,
    title,
    bodyText,
  };
}

function isLikelyBicBlockedByError(error: unknown): boolean {
  return isLikelyBlockedByError(error);
}

function buildArtifactMetadata(params: {
  config: MarketResearchConfig;
  query: string;
  searchUrl: string;
  finalUrl: string;
  crawledAt: string;
  headless: boolean;
  blocked: boolean;
  httpStatus: number | null;
  status: MarketBicSearchStatus;
  artifactDir: string;
  title: string | null;
  resultCount: number;
  error?: MarketArtifactMetadata['error'];
}): MarketBicSearchArtifactMetadata {
  return {
    ...buildMarketArtifactMetadata({
      config: params.config,
      target: TARGET,
      query: params.query,
      url: params.searchUrl,
      finalUrl: params.finalUrl,
      crawledAt: params.crawledAt,
      headless: params.headless,
      blocked: params.blocked,
      error: params.error,
    }),
    source: SOURCE,
    searchUrl: params.searchUrl,
    httpStatus: params.httpStatus,
    status: params.status,
    artifactDir: params.artifactDir,
    resultCount: params.resultCount,
    title: params.title,
  };
}

function buildResultRecord(params: {
  project: string;
  query: string;
  searchUrl: string;
  finalUrl: string;
  item: BicSearchCandidate;
  crawledAt: string;
  artifactDir: string;
}): MarketBicSearchRecord {
  return {
    project: params.project,
    source: SOURCE,
    target: TARGET,
    query: params.query,
    rank: params.item.rank,
    title: params.item.title,
    price: params.item.price,
    pointLabel: params.item.pointLabel,
    stockLabel: params.item.stockLabel,
    productUrl: params.item.productUrl,
    imageUrl: params.item.imageUrl,
    categoryLabel: params.item.categoryLabel,
    searchUrl: params.searchUrl,
    finalUrl: params.finalUrl,
    status: 'ok',
    blocked: false,
    crawledAt: params.crawledAt,
    artifactDir: params.artifactDir,
    errorName: null,
    errorMessage: null,
  };
}

function buildPlaceholderRecord(params: {
  project: string;
  query: string;
  searchUrl: string;
  finalUrl: string;
  status: MarketBicSearchStatus;
  blocked: boolean;
  crawledAt: string;
  artifactDir: string;
  errorName?: string | null;
  errorMessage?: string | null;
}): MarketBicSearchRecord {
  return {
    project: params.project,
    source: SOURCE,
    target: TARGET,
    query: params.query,
    rank: null,
    title: null,
    price: null,
    pointLabel: null,
    stockLabel: null,
    productUrl: null,
    imageUrl: null,
    categoryLabel: null,
    searchUrl: params.searchUrl,
    finalUrl: params.finalUrl,
    status: params.status,
    blocked: params.blocked,
    crawledAt: params.crawledAt,
    artifactDir: params.artifactDir,
    errorName: params.errorName ?? null,
    errorMessage: params.errorMessage ?? null,
  };
}

function summarizeStatuses(records: MarketBicSearchRecord[]): Record<MarketBicSearchStatus, number> {
  return records.reduce<Record<MarketBicSearchStatus, number>>((counts, record) => {
    counts[record.status] += 1;
    return counts;
  }, {
    ok: 0,
    no_results: 0,
    blocked: 0,
    transport_error: 0,
    error: 0,
  });
}

function buildQueryArtifactLabel(query: string, index: number): string {
  const prefix = String(index + 1).padStart(2, '0');
  const normalized = normalizeBicText(query)
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .slice(0, 80);
  return `${prefix}-${normalized || 'query'}`;
}

function normalizeBicText(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function openBicHome(page: Page, timeoutMs: number) {
  await primeBicPage(page);
  const response = await page.goto(BIC_HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(timeoutMs, 30000),
  });
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(800).catch(() => undefined);
  return response;
}

async function preflightBicSession(
  context: BrowserContext,
  timeoutMs: number,
): Promise<{ status: 'ok' | 'blocked' | 'transport_error' | 'error'; title: string; httpStatus: number | null }> {
  const page = await context.newPage();
  let httpStatus: number | null = null;

  try {
    httpStatus = (await openBicHome(page, timeoutMs).catch(() => null))?.status() ?? httpStatus;

    const blockState = await readBicBlockState(page, httpStatus);
    if (blockState.blocked) {
      return {
        status: 'blocked',
        title: blockState.title,
        httpStatus,
      };
    }

    return {
      status: 'ok',
      title: blockState.title,
      httpStatus,
    };
  } catch (error) {
    const blockState = await readBicBlockState(page, httpStatus).catch(() => ({
      blocked: false,
      title: '',
      bodyText: '',
    }));
    const blocked = blockState.blocked || isLikelyBicBlockedByError(error);
    const transportError = !blocked && isLikelyTransportError(error);

    return {
      status: blocked ? 'blocked' : transportError ? 'transport_error' : 'error',
      title: blockState.title,
      httpStatus,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function navigateBicSearch(page: Page, query: string, timeoutMs: number) {
  await openBicHome(page, timeoutMs);

  const searchForm = page.locator('form[action*="/bc/category/"]').first();
  const searchInput = searchForm.locator('input[name="q"]').first();
  const hasSearchForm = await searchForm.count().catch(() => 0);

  if (hasSearchForm === 0 || await searchInput.count().catch(() => 0) === 0) {
    throw new Error('[Bic] ホームの検索フォームが見つかりませんでした');
  }

  const submitButton = searchForm.locator('button[type="submit"], input[type="submit"], .searchBtn, .bcs_searchBtn').first();

  await searchInput.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(400).catch(() => undefined);
  await searchInput.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);
  await searchInput.fill('').catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);
  await searchInput.pressSequentially(query, { delay: 90 }).catch(() => undefined);
  await page.waitForTimeout(350).catch(() => undefined);

  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: paramsSafeTimeout(timeoutMs) }).catch(() => null),
    (async () => {
      if (await submitButton.count().catch(() => 0)) {
        await submitButton.click({ timeout: 5000 }).catch(() => undefined);
        return;
      }

      await searchInput.press('Enter').catch(() => undefined);
    })(),
  ]);

  if (response !== null || isBicSearchResultUrl(page.url())) {
    return response;
  }

  throw new Error('[Bic] ホーム検索フォーム送信後に検索結果ページへ遷移しませんでした');
}

function paramsSafeTimeout(timeoutMs: number): number {
  return Math.max(1000, timeoutMs);
}

function isBicSearchResultUrl(url: string): boolean {
  return url.includes('/bc/category/');
}

async function primeBicPage(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders(BIC_DEFAULT_HEADERS).catch(() => undefined);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}