import { BrowserContext, Page } from 'playwright';
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
  isLikelyBlocked,
  isLikelyBlockedByError,
  readMarketPageBodyText,
} from '../utils/marketPage';
import {
  createMarketOutputPaths,
  getMarketOutputFiles,
  normalizeMarketOutputFormats,
  writeMarketOutputs,
} from '../utils/marketOutput';

type MarketBicSearchStatus = 'ok' | 'no_results' | 'blocked' | 'error';

interface BicSearchCandidate {
  rank: number;
  title: string | null;
  price: string | null;
  pointLabel: string | null;
  stockLabel: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  categoryLabel: string | null;
}

interface BicSearchPageData {
  items: BicSearchCandidate[];
  noResults: boolean;
  pageTitle: string | null;
}

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
const BIC_HOME_URL = 'https://www.biccamera.com/bc/main/';
const BIC_SEARCH_BASE_URL = 'https://www.biccamera.com/bc/category/';

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
  }

  await writeMarketOutputs(
    outputPaths,
    outputFormats,
    records.map((record) => ({ ...record })),
  );

  const summary = summarizeStatuses(records);
  const outputFiles = getMarketOutputFiles(outputPaths, outputFormats);

  console.log(
    `[Market] bic-search 完了: ok=${summary.ok} no_results=${summary.no_results} blocked=${summary.blocked} error=${summary.error}`,
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
      await warmUpBicSession(page, params.timeoutMs);
      const response = await navigateBicSearch(page, params.query, params.searchUrl, params.timeoutMs);
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
      const status: MarketBicSearchStatus = blocked ? 'blocked' : 'error';
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
  return page.evaluate((limit) => {
    const normalizeText = (value: string | null | undefined): string => String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const absoluteUrl = (value: string | null | undefined): string | null => {
      const normalized = normalizeText(value);
      if (!normalized) {
        return null;
      }

      try {
        return new URL(normalized, window.location.href).toString();
      } catch {
        return null;
      }
    };

    const firstText = (root: ParentNode, selectors: string[]): string | null => {
      for (const selector of selectors) {
        const element = root.querySelector(selector);
        const text = normalizeText(element?.textContent);
        if (text) {
          return text;
        }
      }
      return null;
    };

    const allTexts = (root: ParentNode, selectors: string[]): string[] => {
      const values: string[] = [];
      for (const selector of selectors) {
        root.querySelectorAll(selector).forEach((element) => {
          const text = normalizeText(element.textContent);
          if (text) {
            values.push(text);
          }
        });
      }
      return values;
    };

    const extractImageUrl = (root: ParentNode): string | null => {
      const image = root.querySelector<HTMLImageElement>('img');
      if (!image) {
        return null;
      }

      const srcset = normalizeText(image.getAttribute('srcset')).split(',')[0]?.trim().split(/\s+/)[0] ?? '';
      return absoluteUrl(
        image.getAttribute('src')
        || image.getAttribute('data-src')
        || srcset,
      );
    };

    const pickFirstMatching = (root: ParentNode, selectors: string[], predicate: (candidate: string) => boolean): string | null => {
      return allTexts(root, selectors).find((candidate) => predicate(candidate)) ?? null;
    };

    const extractPrice = (root: ParentNode): string | null => pickFirstMatching(
      root,
      ['.bcs_price .val', '.bcs_price', '[class*="price"]', 'span', 'p'],
      (candidate) => candidate.length <= 40 && /([¥￥]|円|税込)/.test(candidate) && /[0-9]/.test(candidate),
    );

    const extractPointLabel = (root: ParentNode): string | null => pickFirstMatching(
      root,
      ['.bcs_point span', '.bcs_point', '[class*="point"]', 'span', 'p'],
      (candidate) => candidate.length <= 80 && /(ポイント|還元|%)/.test(candidate),
    );

    const extractStockLabel = (root: ParentNode): string | null => pickFirstMatching(
      root,
      ['.bcs_zaiko', '.bcs_nouki', '[class*="zaiko"]', '[class*="nouki"]', 'button', 'span', 'p'],
      (candidate) => candidate.length <= 120 && /(在庫|お取り寄せ|販売終了|予定数終了|入荷次第|カートに入れる|出荷|送料無料)/.test(candidate),
    );

    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('li.prod_box, #ga_itam_list li[id^="bcs_item"], .bcs_listItem li'),
    ).filter((node) => node.querySelector('a[href*="/bc/item/"]'));

    const seenProductUrls = new Set<string>();
    const items: BicSearchCandidate[] = [];

    for (const node of nodes) {
      const productUrl = absoluteUrl(
        node.querySelector<HTMLAnchorElement>('.bcs_title a, .bcs_comp_title a, a.bcs_item, a[href*="/bc/item/"]')?.getAttribute('href'),
      );
      if (productUrl && seenProductUrls.has(productUrl)) {
        continue;
      }

      const imageAlt = normalizeText(node.querySelector<HTMLImageElement>('img')?.getAttribute('alt')) || null;
      const title = firstText(node, ['.bcs_title a', '.bcs_comp_title a', 'a.bcs_item']) ?? imageAlt;

      if (!title && !productUrl) {
        continue;
      }

      if (productUrl) {
        seenProductUrls.add(productUrl);
      }

      const categoryCandidate = firstText(node, ['.bcs_category a', '.bcs_category span', '[class*="category"] a', '[class*="category"] span']);
      const categoryLabel = categoryCandidate && categoryCandidate !== title ? categoryCandidate : null;

      items.push({
        rank: items.length + 1,
        title,
        price: extractPrice(node),
        pointLabel: extractPointLabel(node),
        stockLabel: extractStockLabel(node),
        productUrl,
        imageUrl: extractImageUrl(node),
        categoryLabel,
      });

      if (items.length >= limit) {
        break;
      }
    }

    const bodyText = normalizeText(document.body?.innerText || '');
    const noResults = [
      '検索に一致する商品は見つかりませんでした',
      '該当する商品がありません',
      '検索結果はありません',
      '結果は見つかりませんでした',
    ].some((pattern) => bodyText.includes(pattern));

    return {
      items,
      noResults,
      pageTitle: normalizeText(document.title) || null,
    };
  }, maxResults);
}

async function readBicBlockState(page: Page, status: number | null): Promise<{ blocked: boolean; title: string; bodyText: string }> {
  const title = normalizeBicText(await page.title().catch(() => ''));
  const bodyText = normalizeBicText(await readMarketPageBodyText(page));
  const normalized = `${title}\n${bodyText}`.toLowerCase();
  const blocked = isLikelyBlocked(status, bodyText) || [
    'powered and protected by',
    'access denied',
    'forbidden',
    'captcha',
    'not a robot',
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
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return isLikelyBlockedByError(error) || [
    'err_http2_protocol_error',
    'timed out',
    'read timed out',
  ].some((pattern) => message.includes(pattern));
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

async function warmUpBicSession(page: Page, timeoutMs: number): Promise<void> {
  await page.goto(BIC_HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(timeoutMs, 30000),
  }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);
}

async function navigateBicSearch(page: Page, query: string, searchUrl: string, timeoutMs: number) {
  const searchInput = page.locator('form[action*="/bc/category/"] input[name="q"]').first();
  const hasSearchForm = await searchInput.count().catch(() => 0);

  if (hasSearchForm > 0) {
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: paramsSafeTimeout(timeoutMs) }).catch(() => null),
      searchInput.evaluate((input, value) => {
        if (!(input instanceof HTMLInputElement)) {
          return;
        }

        input.value = String(value);
        input.form?.submit();
      }, query),
    ]);

    if (response !== null) {
      return response;
    }
  }

  return page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
}

function paramsSafeTimeout(timeoutMs: number): number {
  return Math.max(1000, timeoutMs);
}

// BicCamera search currently uses /bc/category/?q=<query> and may add parameters like preQ or sold_out_tp2 after redirect.
function buildBicSearchUrl(query: string): string {
  const url = new URL(BIC_SEARCH_BASE_URL);
  url.searchParams.set('q', query);
  return url.toString();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}