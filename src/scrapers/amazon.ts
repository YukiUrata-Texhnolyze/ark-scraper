/**
 * Amazonスクレイパー
 *
 * PADフロー「Amazon」の移植版。
 * 収集カラム:
 *   B列(2): 商品名
 *   C列(3): 価格
 *   D列(4): ASIN
 *
 * マーチャントID: A290QSZB4BCGSX
 * URL: https://www.amazon.co.jp/s?i=merchant-items&me={merchantId}&page={page}&marketplaceID=A1VC38T7YXB528
 */

import { BrowserContext } from 'playwright';
import { CsvManager } from '../utils/csv';
import { AmazonConfig, AmazonItem } from '../types';

const PAGE_WAIT_MS = 3000;
const MARKETPLACE_ID = 'A1VC38T7YXB528';
const AMAZON_MAX_PAGE_OPEN_ATTEMPTS = Number(process.env.AMAZON_MAX_PAGE_OPEN_ATTEMPTS ?? '8');
const AMAZON_RETRY_DELAY_BASE_MS = Number(process.env.AMAZON_RETRY_DELAY_BASE_MS ?? '2500');
const AMAZON_RETRY_DELAY_JITTER_MS = Number(process.env.AMAZON_RETRY_DELAY_JITTER_MS ?? '1500');
const AMAZON_DELIVERY_POSTAL_CODE = (process.env.AMAZON_DELIVERY_POSTAL_CODE ?? '').replace(/\D/g, '');
const AMAZON_BLOCK_PATTERNS = [
  'ご迷惑をおかけしています',
  'お客様のリクエストの処理中にエラーが発生しました',
  '入力された文字を下に表示',
  'ロボットではありません',
  'captcha',
];

interface AmazonSummaryInfo {
  text: string;
  total: number;
  start: number;
  end: number;
}

/**
 * Amazon商品一覧を1ページから取得する
 */
async function extractAmazonItems(page: import('playwright').Page): Promise<AmazonItem[]> {
  const results: AmazonItem[] = [];
  const seenAsins = new Set<string>();

  // data-asin が空でない商品ブロックをすべて取得
  const itemLocators = await page
    .locator('.s-main-slot [data-component-type="s-search-result"][data-asin]:not([data-asin=""]), .s-main-slot [data-asin]:not([data-asin=""])')
    .all();

  for (const item of itemLocators) {
    try {
      const asin = (await item.getAttribute('data-asin')) ?? '';
      if (!asin || seenAsins.has(asin)) continue;
      seenAsins.add(asin);

      // 商品タイトル
      // PAD: div > ... > h2 > a > span  (Own Text)
      const titleEl = item.locator('h2 a span, h2 span').first();
      const title = (await titleEl.textContent({ timeout: 3000 }))?.trim() ?? '';

      // 価格
      // PAD: div > ... > div:eq(2) > div:eq(0) > div > div > div > div:eq(0) > a > span > span:eq(1) > span:eq(1)
      // Amazonの価格は .a-price-whole + .a-price-fraction
      let price = '';
      try {
        const offscreen = await item.locator('.a-price .a-offscreen, [data-cy="price-recipe"] .a-offscreen').first().textContent({ timeout: 2000 });
        if (offscreen) {
          price = offscreen.replace(/[￥¥,\s]/g, '').trim();
        } else {
          const whole = await item.locator('.a-price-whole').first().textContent({ timeout: 2000 });
          const fraction = await item.locator('.a-price-fraction').first().textContent({ timeout: 2000 });
          if (whole) {
            price = fraction ? `${whole.trim()}.${fraction.trim()}` : whole.trim();
          }
        }
      } catch {
        // 価格なし (在庫切れ等)
      }

      results.push({ asin, title, price });
    } catch (e) {
      console.warn(`[Amazon] アイテム取得エラー: ${e}`);
    }
  }

  return results;
}

/**
 * メインのAmazonスクレイパー関数
 */
export async function scrapeAmazon(
  context: BrowserContext,
  config: AmazonConfig,
): Promise<void> {
  const { merchantId, prefix, csvFileName } = config;

  console.log(`\n[Amazon] スクレイピング開始 (merchantId: ${merchantId})`);

  const csv = new CsvManager(`${prefix}${csvFileName}`);
  const existingAsins = csv.getColumnValues(4)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  let row = csv.getCurrentRow();
  let shouldSave = true;
  const seenAsins = new Set<string>(existingAsins);
  let expectedTotalPages = 0;
  let page: import('playwright').Page | null = null;
  const initialRow = row;
  const startPage = getAmazonStartPage(existingAsins.length);

  if (existingAsins.length > 0) {
    console.log(`[Amazon] 既存CSVから再開: ${existingAsins.length} 件 (page ${startPage} から)`);
  }

  await applyAmazonStealth(context);

  try {
    page = await openAmazonPageWithRetries(context, merchantId, startPage, expectedTotalPages);

    while (true) {
      const currentPageNum = await getCurrentAmazonPageNumber(page);
      console.log(`[Amazon] ページ ${currentPageNum} 取得中... (${page.url()})`);

      if (expectedTotalPages === 0) {
        expectedTotalPages = await estimateAmazonTotalPages(page);
        if (expectedTotalPages > 0) {
          console.log(`[Amazon] 想定総ページ数: ${expectedTotalPages}`);
        }
      }

      const items = (await extractAmazonItems(page)).filter((item) => {
        if (seenAsins.has(item.asin)) {
          return false;
        }

        seenAsins.add(item.asin);
        return true;
      });
      console.log(`[Amazon] ページ ${currentPageNum}: ${items.length} 件`);

      for (const item of items) {
        csv.writeCell(row, 2, item.title);
        csv.writeCell(row, 3, item.price);
        csv.writeCell(row, 4, item.asin);
        row++;
      }

      if (items.length > 0) {
        await csv.save();
      }

      if (items.length === 0) {
        const nextUrl = await getAmazonNextPageUrl(page, currentPageNum, expectedTotalPages);
        if (!nextUrl) {
          console.log('[Amazon] 商品なし、終了');
          break;
        }

        console.log('[Amazon] このページに新規商品なし。次ページへ進みます');
        const nextPage = await openAmazonPageWithRetries(
          context,
          merchantId,
          currentPageNum + 1,
          expectedTotalPages,
          nextUrl,
        );
        await page.close().catch(() => undefined);
        page = nextPage;
        continue;
      }

      const nextUrl = await getAmazonNextPageUrl(page, currentPageNum, expectedTotalPages);
      if (!nextUrl) {
        console.log('[Amazon] 最終ページ到達');
        break;
      }

      const nextPage = await openAmazonPageWithRetries(
        context,
        merchantId,
        currentPageNum + 1,
        expectedTotalPages,
        nextUrl,
      );
      await page.close().catch(() => undefined);
      page = nextPage;
    }

  } catch (error) {
    if (error instanceof Error && error.message.includes('ボット検知') && row === initialRow) {
      shouldSave = false;
    }
    throw error;

  } finally {
    if (shouldSave) {
      await csv.save();
    }
    await page?.close().catch(() => undefined);
  }

  console.log(`[Amazon] 完了 (${row - 1}件)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function warmUpAmazonSession(
  page: import('playwright').Page,
  merchantId: string,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
  });
  await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await continueAmazonShoppingIfNeeded(page);
  await sleep(1500);
  await ensureAmazonDeliveryLocation(page);
  await page.goto(`https://www.amazon.co.jp/sp?marketplaceID=${MARKETPLACE_ID}&seller=${merchantId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => undefined);
  await sleep(1000);
}

async function createAmazonPage(
  context: BrowserContext,
): Promise<import('playwright').Page> {
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
  });

  return page;
}

async function continueAmazonShoppingIfNeeded(
  page: import('playwright').Page,
): Promise<void> {
  const bodyText = normalizeAmazonText((await page.textContent('body')) ?? '');
  if (!bodyText.includes('ショッピングを続けてください')) {
    return;
  }

  const continueButton = page.getByText('ショッピングを続ける').first();
  if ((await continueButton.count()) === 0) {
    return;
  }

  console.log('[Amazon] continue-shopping 中間画面を突破');
  await continueButton.click({ timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await sleep(2500);
}

async function ensureAmazonDeliveryLocation(
  page: import('playwright').Page,
): Promise<void> {
  const currentDestination = await getAmazonDeliveryDestination(page);
  if (currentDestination) {
    console.log(`[Amazon] 現在のお届け先: ${currentDestination}`);
  }

  if (!AMAZON_DELIVERY_POSTAL_CODE) {
    return;
  }

  const trigger = page.locator('#nav-global-location-popover-link, #glow-ingress-block').first();
  if ((await trigger.count()) === 0) {
    console.warn('[Amazon] お届け先トリガーが見つからないため更新をスキップ');
    return;
  }

  await trigger.click({ timeout: 10000 }).catch(() => undefined);
  await sleep(1500);

  const firstZipInput = page.locator('#GLUXZipUpdateInput_0, #GLUXZipUpdateInput').first();
  if ((await firstZipInput.count()) === 0) {
    console.warn('[Amazon] 郵便番号入力欄が見つからないため更新をスキップ');
    await closeAmazonDeliveryPopover(page);
    return;
  }

  const [zipPart1, zipPart2] = splitAmazonPostalCode(AMAZON_DELIVERY_POSTAL_CODE);
  await firstZipInput.fill(zipPart1).catch(() => undefined);

  const secondZipInput = page.locator('#GLUXZipUpdateInput_1').first();
  if ((await secondZipInput.count()) > 0 && zipPart2) {
    await secondZipInput.fill(zipPart2).catch(() => undefined);
  }

  await page.locator('#GLUXZipUpdate').first().click({ timeout: 10000 }).catch(() => undefined);
  await sleep(3500);
  await closeAmazonDeliveryPopover(page);

  const updatedDestination = await getAmazonDeliveryDestination(page);
  if (updatedDestination) {
    console.log(`[Amazon] 更新後のお届け先: ${updatedDestination}`);
  }
}

async function closeAmazonDeliveryPopover(
  page: import('playwright').Page,
): Promise<void> {
  const closeButton = page.locator('#GLUXConfirmClose').first();
  if ((await closeButton.count()) > 0) {
    await closeButton.click({ timeout: 5000 }).catch(() => undefined);
    await sleep(1000);
  }
}

async function getAmazonDeliveryDestination(
  page: import('playwright').Page,
): Promise<string> {
  try {
    return normalizeAmazonText(
      (await page.locator('#glow-ingress-line2').first().textContent({ timeout: 1500 })) ?? '',
    );
  } catch {
    return '';
  }
}

function splitAmazonPostalCode(postalCode: string): [string, string] {
  if (postalCode.length <= 3) {
    return [postalCode, ''];
  }

  return [postalCode.slice(0, 3), postalCode.slice(3, 7)];
}

function normalizeAmazonText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function applyAmazonStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ja-JP', 'ja', 'en-US', 'en'],
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    if (!(window as Window & { chrome?: object }).chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {} },
        configurable: true,
      });
    }
  });
}

async function assertAmazonNotBlocked(
  page: import('playwright').Page,
  pageNum: number,
): Promise<void> {
  const title = await page.title();
  const bodyText = ((await page.textContent('body')) ?? '').replace(/\s+/g, ' ').trim();
  const normalized = `${title} ${bodyText}`.toLowerCase();
  const blocked = AMAZON_BLOCK_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));

  if (blocked) {
    throw new Error(
      `[Amazon] ページ ${pageNum} はボット検知またはエラーページでした: ${title || '無題'}`,
    );
  }
}

async function openAmazonResultsPage(
  page: import('playwright').Page,
  merchantId: string,
  pageNum: number,
  expectedTotalPages: number,
  preferredUrl?: string,
): Promise<void> {
  const candidateUrls = [preferredUrl, ...buildAmazonCandidateUrls(merchantId, pageNum)]
    .filter((url): url is string => Boolean(url));
  let lastError: Error | undefined;

  for (const url of candidateUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(getAmazonPageWaitMs());
      await assertAmazonResultsReady(page, pageNum, expectedTotalPages);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`[Amazon] ページ ${pageNum} の読み込みに失敗しました`);
}

async function openAmazonPageWithRetries(
  context: BrowserContext,
  merchantId: string,
  pageNum: number,
  expectedTotalPages: number,
  preferredUrl?: string,
): Promise<import('playwright').Page> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= AMAZON_MAX_PAGE_OPEN_ATTEMPTS; attempt++) {
    const page = await createAmazonPage(context);

    try {
      await warmUpAmazonSession(page, merchantId);
      await openAmazonResultsPage(page, merchantId, pageNum, expectedTotalPages, preferredUrl);
      if (attempt > 1) {
        console.log(`[Amazon] ページ ${pageNum} は ${attempt} 回目で成功`);
      }
      return page;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`[Amazon] ページ ${pageNum} 試行 ${attempt}/${AMAZON_MAX_PAGE_OPEN_ATTEMPTS} 失敗: ${lastError.message}`);
      await page.close().catch(() => undefined);

      if (attempt < AMAZON_MAX_PAGE_OPEN_ATTEMPTS) {
        await sleep(getAmazonRetryDelayMs(attempt));
      }
    }
  }

  throw lastError ?? new Error(`[Amazon] ページ ${pageNum} の読み込みに失敗しました`);
}

async function getAmazonNextPageUrl(
  page: import('playwright').Page,
  currentPageNum: number,
  expectedTotalPages: number,
): Promise<string> {
  const nextBtn = page.locator('a.s-pagination-next:not(.s-pagination-disabled), a[aria-label*="次へ"]:not(.s-pagination-disabled)').first();
  if ((await nextBtn.count()) > 0) {
    const href = await nextBtn.getAttribute('href');
    if (href) {
      return href.startsWith('http') ? href : new URL(href, page.url()).toString();
    }
  }

  if (expectedTotalPages > 0 && currentPageNum >= expectedTotalPages) {
    return '';
  }

  const fallbackUrl = buildAmazonPageUrl(page.url(), currentPageNum + 1);
  return fallbackUrl !== page.url() ? fallbackUrl : '';
}

async function getCurrentAmazonPageNumber(
  page: import('playwright').Page,
): Promise<number> {
  try {
    const selected = await page
      .locator('.s-pagination-item.s-pagination-selected')
      .first()
      .textContent({ timeout: 2000 });
    const parsed = Number((selected ?? '').trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    // ignore and fall back to URL
  }

  try {
    const url = new URL(page.url());
    const parsed = Number(url.searchParams.get('page') ?? '1');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  } catch {
    return 1;
  }
}

function buildAmazonCandidateUrls(merchantId: string, pageNum: number): string[] {
  const urls = [
    buildAmazonMerchantItemsUrl(merchantId, pageNum),
    buildAmazonMerchantItemsUrl(merchantId, pageNum, MARKETPLACE_ID),
    buildAmazonMerchantItemsUrl(merchantId, pageNum, MARKETPLACE_ID, true),
    buildAmazonMerchantMeUrl(merchantId, pageNum, MARKETPLACE_ID),
    buildAmazonMerchantMeUrl(merchantId, pageNum),
  ];

  return [...new Set(urls)];
}

function buildAmazonMerchantItemsUrl(
  merchantId: string,
  pageNum: number,
  marketplaceId?: string,
  includeQid = false,
): string {
  const url = new URL('https://www.amazon.co.jp/s');
  url.searchParams.set('i', 'merchant-items');
  url.searchParams.set('me', merchantId);
  if (marketplaceId) {
    url.searchParams.set('marketplaceID', marketplaceId);
  }
  if (pageNum > 1) {
    url.searchParams.set('page', String(pageNum));
  }
  if (includeQid) {
    url.searchParams.set('qid', String(Math.floor(Date.now() / 1000)));
  }

  return url.toString();
}

function buildAmazonMerchantMeUrl(
  merchantId: string,
  pageNum: number,
  marketplaceId?: string,
): string {
  const url = new URL('https://www.amazon.co.jp/s');
  url.searchParams.set('me', merchantId);
  if (marketplaceId) {
    url.searchParams.set('marketplaceID', marketplaceId);
  }
  if (pageNum > 1) {
    url.searchParams.set('page', String(pageNum));
  }

  return url.toString();
}

async function estimateAmazonTotalPages(
  page: import('playwright').Page,
): Promise<number> {
  const summary = await getAmazonSummaryInfo(page);
  if (summary) {
    const perPage = summary.end >= summary.start ? summary.end - summary.start + 1 : 0;
    if (summary.total > 0 && perPage > 0) {
      return Math.ceil(summary.total / perPage);
    }
  }

  return 0;
}

async function assertAmazonResultsReady(
  page: import('playwright').Page,
  pageNum: number,
  expectedTotalPages: number,
): Promise<void> {
  await assertAmazonNotBlocked(page, pageNum);

  const summary = await getAmazonSummaryInfo(page);
  if (summary && summary.end < summary.start) {
    throw new Error(`[Amazon] ページ ${pageNum} の件数表示が不正です: ${summary.text}`);
  }

  const itemCount = await countAmazonResultNodes(page);
  if (itemCount > 0) {
    return;
  }

  if (expectedTotalPages > 0 && pageNum > expectedTotalPages) {
    return;
  }

  throw new Error(`[Amazon] ページ ${pageNum} の商品取得に失敗しました`);
}

async function getAmazonSummaryInfo(
  page: import('playwright').Page,
): Promise<AmazonSummaryInfo | null> {
  const summaryTexts = await page
    .locator('span:has-text("結果"), .sg-col-inner .a-section span')
    .allTextContents()
    .catch(() => []);

  for (const text of summaryTexts) {
    const normalized = text.replace(/\s+/g, '');
    const match = normalized.match(/([0-9,]+)結果の([0-9,]+)-([0-9,]+)/u);
    if (!match) {
      continue;
    }

    return {
      text: match[0],
      total: Number(match[1].replace(/,/g, '')),
      start: Number(match[2].replace(/,/g, '')),
      end: Number(match[3].replace(/,/g, '')),
    };
  }

  return null;
}

async function countAmazonResultNodes(
  page: import('playwright').Page,
): Promise<number> {
  return page
    .locator('.s-main-slot [data-component-type="s-search-result"][data-asin]:not([data-asin=""]), .s-main-slot [data-asin]:not([data-asin=""])')
    .count()
    .catch(() => 0);
}

function getAmazonRetryDelayMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * AMAZON_RETRY_DELAY_JITTER_MS);
  return AMAZON_RETRY_DELAY_BASE_MS * attempt + jitter;
}

function getAmazonPageWaitMs(): number {
  return PAGE_WAIT_MS + Math.floor(Math.random() * 1200);
}

function buildAmazonPageUrl(currentUrl: string, pageNum: number): string {
  try {
    const url = new URL(currentUrl);
    url.searchParams.set('page', String(pageNum));
    return url.toString();
  } catch {
    return currentUrl;
  }
}

function getAmazonStartPage(existingItemCount: number): number {
  if (existingItemCount <= 0) {
    return 1;
  }

  return Math.max(1, Math.floor(existingItemCount / 16) + 1);
}
