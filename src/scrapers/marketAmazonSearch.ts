import { BrowserContext, Page } from 'playwright';
import { resolveMarketAmazonQueries } from '../config/marketResearchConfig';
import { MarketArtifactMetadata, MarketResearchConfig } from '../types';
import {
  createMarketArtifactPaths,
  saveMarketErrorArtifacts,
  saveMarketSuccessArtifacts,
  toMarketArtifactErrorInfo,
} from '../utils/marketArtifacts';
import {
  applyAmazonStealth,
  assertAmazonNotBlocked,
  buildAmazonSearchUrl,
  continueAmazonShoppingIfNeeded,
  createAmazonPage,
  getAmazonMaxPageOpenAttempts,
  getAmazonPageWaitMs,
  getAmazonRetryDelayMs,
  normalizeAmazonText,
  readAmazonBlockState,
  warmUpAmazonSession,
} from '../utils/amazonSession';
import { buildMarketArtifactMetadata, isLikelyBlockedByError, isLikelyTransportError } from '../utils/marketPage';
import {
  createMarketOutputPaths,
  getMarketOutputFiles,
  normalizeMarketOutputFormats,
  writeMarketOutputs,
} from '../utils/marketOutput';

type MarketAmazonSearchStatus = 'ok' | 'blocked' | 'transport_error' | 'error';

interface AmazonSearchCandidate {
  rank: number;
  asin: string | null;
  title: string | null;
  brand: string | null;
  price: string | null;
  rating: string | null;
  reviewCount: string | null;
  isSponsored: boolean;
  primeOrDeliveryLabel: string | null;
  couponLabel: string | null;
  imageUrl: string | null;
  productUrl: string | null;
}

interface AmazonSearchPageData {
  items: AmazonSearchCandidate[];
  noResults: boolean;
  pageTitle: string | null;
}

export interface MarketAmazonSearchRecord {
  project: string;
  source: 'amazon';
  target: 'market-amazon-search';
  query: string;
  rank: number | null;
  asin: string | null;
  title: string | null;
  brand: string | null;
  price: string | null;
  rating: string | null;
  reviewCount: string | null;
  isSponsored: boolean;
  primeOrDeliveryLabel: string | null;
  couponLabel: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  searchUrl: string;
  finalUrl: string;
  status: MarketAmazonSearchStatus;
  blocked: boolean;
  crawledAt: string;
  artifactDir: string;
  errorName: string | null;
  errorMessage: string | null;
}

export interface MarketAmazonSearchResult {
  artifactDirs: string[];
  outputFiles: string[];
  records: MarketAmazonSearchRecord[];
}

export interface MarketAmazonSearchOptions {
  headless: boolean;
  runAt?: Date;
  artifactRootDir?: string;
  outputDir?: string;
  timeoutMs?: number;
  maxResults?: number;
}

type MarketAmazonSearchArtifactMetadata = MarketArtifactMetadata & {
  source: 'amazon';
  searchUrl: string;
  httpStatus: number | null;
  status: MarketAmazonSearchStatus;
  artifactDir: string;
  resultCount: number;
  title: string | null;
};

const TARGET = 'market-amazon-search' as const;
const SOURCE = 'amazon' as const;
const DEFAULT_MAX_RESULTS = 20;

export async function scrapeMarketAmazonSearch(
  context: BrowserContext,
  config: MarketResearchConfig,
  options: MarketAmazonSearchOptions,
): Promise<MarketAmazonSearchResult> {
  const runAt = options.runAt ?? new Date();
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const queries = resolveMarketAmazonQueries(config);
  const outputFormats = normalizeMarketOutputFormats(config.outputFormats);
  const outputPaths = await createMarketOutputPaths(TARGET, runAt, options.outputDir);
  const artifactDirs: string[] = [];
  const records: MarketAmazonSearchRecord[] = [];

  await applyAmazonStealth(context);

  for (const [index, query] of queries.entries()) {
    const searchUrl = buildAmazonSearchUrl(query);
    const artifactPaths = createMarketArtifactPaths(
      config.project,
      TARGET,
      runAt,
      options.artifactRootDir,
      buildQueryArtifactLabel(query, index),
    );

    artifactDirs.push(artifactPaths.artifactDir);

    const queryResult = await crawlAmazonSearchQuery(context, config, {
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

  console.log(`[Market] amazon-search 完了: ok=${summary.ok} blocked=${summary.blocked} transport_error=${summary.transport_error} error=${summary.error}`);
  console.log(`[Market] 出力: ${outputFiles.join(', ')}`);

  return {
    artifactDirs,
    outputFiles,
    records,
  };
}

async function crawlAmazonSearchQuery(
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
): Promise<{ records: MarketAmazonSearchRecord[] }> {
  const maxAttempts = getAmazonMaxPageOpenAttempts();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const page = await createAmazonPage(context);
    let httpStatus: number | null = null;
    let finalUrl = params.searchUrl;

    try {
      await warmUpAmazonSession(page);
      const response = await page.goto(params.searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: params.timeoutMs,
      });
      httpStatus = response?.status() ?? null;

      const continued = await continueAmazonShoppingIfNeeded(page);
      if (continued) {
        const retryResponse = await page.goto(params.searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: params.timeoutMs,
        }).catch(() => null);
        httpStatus = retryResponse?.status() ?? httpStatus;
      }

      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(getAmazonPageWaitMs()).catch(() => undefined);
      finalUrl = page.url() || params.searchUrl;

      const blockState = await readAmazonBlockState(page, httpStatus);
      const intermediateBlocked = blockState.bodyText.includes('ショッピングを続けてください');
      if (blockState.blocked || intermediateBlocked) {
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
          title: blockState.title,
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
            errorMessage: intermediateBlocked ? 'Amazon continue-shopping page blocked result extraction' : null,
          })],
        };
      }

      await assertAmazonNotBlocked(page, `検索クエリ ${params.query}`);

      const pageData = await extractAmazonSearchResults(page, params.maxResults);
      const metadata = buildArtifactMetadata({
        config,
        query: params.query,
        searchUrl: params.searchUrl,
        finalUrl,
        crawledAt: params.crawledAt,
        headless: params.headless,
        blocked: false,
        httpStatus,
        status: 'ok',
        artifactDir: params.artifactPaths.artifactDir,
        title: pageData.pageTitle,
        resultCount: pageData.items.length,
      });
      await saveMarketSuccessArtifacts(page, params.artifactPaths, metadata);

      if (pageData.items.length === 0) {
        return {
          records: [buildPlaceholderRecord({
            project: config.project,
            query: params.query,
            searchUrl: params.searchUrl,
            finalUrl,
            status: 'ok',
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
      const finalAttempt = attempt === maxAttempts;

      if (!finalAttempt) {
        console.warn(`[Market] amazon-search query="${params.query}" retry ${attempt}/${maxAttempts}: ${errorInfo.message}`);
        await page.close().catch(() => undefined);
        await sleep(getAmazonRetryDelayMs(attempt));
        continue;
      }

      finalUrl = page.url() || finalUrl;
      const blockState = await readAmazonBlockState(page, httpStatus).catch(() => ({
        blocked: isLikelyBlockedByError(error),
        title: '',
        bodyText: '',
      }));
      const transportError = !blockState.blocked && isLikelyTransportError(error);
      const status: MarketAmazonSearchStatus = blockState.blocked ? 'blocked' : transportError ? 'transport_error' : 'error';
      const metadata = buildArtifactMetadata({
        config,
        query: params.query,
        searchUrl: params.searchUrl,
        finalUrl,
        crawledAt: params.crawledAt,
        headless: params.headless,
        blocked: blockState.blocked,
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
          blocked: blockState.blocked,
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

async function extractAmazonSearchResults(page: Page, maxResults: number): Promise<AmazonSearchPageData> {
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

    const extractReviewCount = (root: ParentNode): string | null => {
      const reviewLinks = Array.from(
        root.querySelectorAll<HTMLAnchorElement>('a[href*="customerReviews"], a[href*="#customerReviews"]'),
      );

      for (const link of reviewLinks) {
        const ariaLabel = normalizeText(link.getAttribute('aria-label'));
        const text = normalizeText(link.textContent);
        const candidate = ariaLabel || text;

        const parenMatch = candidate.match(/\(([0-9,]+)\)/);
        if (parenMatch?.[1]) {
          return parenMatch[1];
        }

        const match = candidate.match(/[0-9][0-9,]*/);
        if (match?.[0]) {
          return match[0];
        }
      }

      const candidates = allTexts(root, [
        '[aria-label*="件の評価"]',
        '[aria-label*="ratings"]',
        'a[href*="customerReviews"] span',
        'a[href*="#customerReviews"] span',
      ]);

      for (const candidate of candidates) {
        if (/^[0-9,]+$/.test(candidate)) {
          return candidate;
        }

        const match = candidate.match(/[0-9,]+/);
        if (match?.[0] && /(評価|rating|件)/i.test(candidate)) {
          return match[0];
        }
      }

      return null;
    };

    const extractPrimeOrDeliveryLabel = (root: ParentNode): string | null => {
      const candidates = allTexts(root, [
        '[aria-label*="Prime"]',
        '.a-icon-prime',
        '[data-cy="delivery-recipe"] span',
        '.a-color-base.a-text-bold',
        '.a-color-base.a-size-base',
      ]);

      return candidates.find((candidate) => /prime|お届け|配送|明日|本日/i.test(candidate)) ?? null;
    };

    const extractCouponLabel = (root: ParentNode): string | null => {
      const candidates = allTexts(root, [
        '.s-coupon-unclipped',
        '[class*="coupon"]',
        '[aria-label*="クーポン"]',
        'span',
      ]).filter((candidate) => candidate.includes('クーポン') && candidate.length <= 80);

      return candidates.find((candidate) => /クーポン|OFF|オフ/.test(candidate)) ?? null;
    };

    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.s-main-slot [data-component-type="s-search-result"][data-asin]:not([data-asin=""])'))
      .slice(0, limit);
    const items = nodes
      .map((item, index) => {
        const asin = normalizeText(item.getAttribute('data-asin')) || null;
        const title = firstText(item, ['h2 a span', 'h2 span', '[data-cy="title-recipe"] h2 span']);
        const brandCandidate = firstText(item, [
          '.a-row.a-size-base.a-color-secondary .a-size-base.a-color-base',
          '.a-size-base-plus.a-color-base',
        ]);
        const brand = brandCandidate && brandCandidate !== title ? brandCandidate : null;
        const price = firstText(item, [
          '.a-price .a-offscreen',
          '[data-cy="price-recipe"] .a-offscreen',
          '.a-price-range .a-offscreen',
          '.a-price-whole',
        ]);
        const rating = firstText(item, ['.a-icon-alt']);
        const reviewCount = extractReviewCount(item);
        const itemText = normalizeText(item.textContent);
        const isSponsored = itemText.includes('スポンサー');
        const primeOrDeliveryLabel = extractPrimeOrDeliveryLabel(item);
        const couponLabel = extractCouponLabel(item);
        const imageUrl = absoluteUrl(item.querySelector<HTMLImageElement>('img.s-image, img')?.getAttribute('src'));
        const productUrl = absoluteUrl(item.querySelector<HTMLAnchorElement>('h2 a, a.a-link-normal.s-no-outline')?.getAttribute('href'));

        return {
          rank: index + 1,
          asin,
          title,
          brand,
          price,
          rating,
          reviewCount,
          isSponsored,
          primeOrDeliveryLabel,
          couponLabel,
          imageUrl,
          productUrl,
        };
      })
      .filter((item) => Boolean(item.asin || item.title || item.productUrl));

    const bodyText = normalizeText(document.body?.innerText || '');
    const noResults = [
      '一致する商品はありません',
      '検索結果はありません',
      '結果は見つかりませんでした',
      '検索に一致する商品はありません',
    ].some((pattern) => bodyText.includes(pattern));

    return {
      items,
      noResults,
      pageTitle: normalizeText(document.title) || null,
    };
  }, maxResults);
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
  status: MarketAmazonSearchStatus;
  artifactDir: string;
  title: string | null;
  resultCount: number;
  error?: MarketArtifactMetadata['error'];
}): MarketAmazonSearchArtifactMetadata {
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
  item: AmazonSearchCandidate;
  crawledAt: string;
  artifactDir: string;
}): MarketAmazonSearchRecord {
  return {
    project: params.project,
    source: SOURCE,
    target: TARGET,
    query: params.query,
    rank: params.item.rank,
    asin: params.item.asin,
    title: params.item.title,
    brand: params.item.brand,
    price: params.item.price,
    rating: params.item.rating,
    reviewCount: params.item.reviewCount,
    isSponsored: params.item.isSponsored,
    primeOrDeliveryLabel: params.item.primeOrDeliveryLabel,
    couponLabel: params.item.couponLabel,
    imageUrl: params.item.imageUrl,
    productUrl: params.item.productUrl,
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
  status: MarketAmazonSearchStatus;
  blocked: boolean;
  crawledAt: string;
  artifactDir: string;
  errorName?: string | null;
  errorMessage?: string | null;
}): MarketAmazonSearchRecord {
  return {
    project: params.project,
    source: SOURCE,
    target: TARGET,
    query: params.query,
    rank: null,
    asin: null,
    title: null,
    brand: null,
    price: null,
    rating: null,
    reviewCount: null,
    isSponsored: false,
    primeOrDeliveryLabel: null,
    couponLabel: null,
    imageUrl: null,
    productUrl: null,
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

function summarizeStatuses(records: MarketAmazonSearchRecord[]): Record<MarketAmazonSearchStatus, number> {
  return records.reduce<Record<MarketAmazonSearchStatus, number>>((counts, record) => {
    counts[record.status] += 1;
    return counts;
  }, {
    ok: 0,
    blocked: 0,
    transport_error: 0,
    error: 0,
  });
}

function buildQueryArtifactLabel(query: string, index: number): string {
  const prefix = String(index + 1).padStart(2, '0');
  const normalized = normalizeAmazonText(query)
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .slice(0, 80);
  return `${prefix}-${normalized || 'query'}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}