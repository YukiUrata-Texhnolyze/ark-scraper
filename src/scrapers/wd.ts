/**
 * Western Digitalスクレイパー
 *
 * PADフロー「WD_copy」の移植版。
 *
 * 処理概要:
 *  1. WD製品一覧ページを開く
 *  2. Cookie同意ボタンをクリック (存在する場合)
 *  3. 製品一覧から /products/ を含むURLを全ページ収集 (a#nextbtn でページネーション)
 *  4. 各製品ページで JavaScript を実行し、JANコードとバリアントURLを取得
 *  5. バリアントURLを開き、タイトル・価格・購入ボタンテキストを取得
 *  6. CSVに書き込み
 *
 * 収集カラム:
 *   A列(1): JANコード
 *   B列(2): 商品名
 *   C列(3): 価格 (¥ 以降の数値)
 *   D列(4): 購入ボタンテキスト / 在庫状況
 *   E列(5): 割引価格
 *   F列(6): クロール日時
 */

import { BrowserContext, Page } from 'playwright';
import { CsvManager } from '../utils/csv';
import { WDConfig, WDItem } from '../types';

const PAGE_WAIT_MS = 2500;
const ITEM_WAIT_MS = 400;
const VARIANT_DELAY_MAX_MS = 800;
const PRODUCT_COOLDOWN_EVERY = 5;
const PRODUCT_COOLDOWN_MS = 5000;
const NAVIGATION_BACKOFF_MS = 8000;

/**
 * WD製品一覧ページから全製品URLを収集する
 */
async function collectProductUrls(listPage: Page): Promise<string[]> {
  const allUrls = new Set<string>();
  const visitedPages = new Set<string>();

  while (true) {
    visitedPages.add(listPage.url());

    try {
      await listPage.waitForSelector('.clp-product-listing-wrap a[href*="/products/"]', {
        timeout: 15000,
      });
    } catch {
      // 商品カード未描画でもフォールバックの全リンク収集は試す
    }

    const hrefs = await listPage.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/products/"]'))
        .map((el) => el.getAttribute('href') ?? '')
        .filter(
          (href) => href.length > 0 && href.includes('sku=') && !href.includes('#') && !href.endsWith('/products'),
        );
    });

    for (const href of hrefs) {
      const fullUrl = href.startsWith('https')
        ? href
        : `https://www.westerndigital.com${href}`;
      allUrls.add(fullUrl);
    }

    // 次ページ確認
    // PAD: a#nextbtn に pointer-events-none クラスがあれば最終ページ
    const nextBtnDisabled = listPage.locator('a#nextbtn.pointer-events-none');
    const isLastPage = (await nextBtnDisabled.count()) > 0;

    if (isLastPage) break;

    const nextBtn = listPage.locator('a#nextbtn');
    if ((await nextBtn.count()) === 0) break;

    const nextHref = await nextBtn.first().getAttribute('href');
    if (!nextHref) break;

    const nextUrl = nextHref.startsWith('https')
      ? nextHref
      : `https://www.westerndigital.com${nextHref}`;

    if (visitedPages.has(nextUrl)) break;

    await listPage.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(PAGE_WAIT_MS);
  }

  return Array.from(allUrls);
}

/**
 * JANコードとバリアントURLのペアを JavaScript で抽出する
 *
 * PAD の JavaScript と同等の処理:
 *   .product-sku-list .show-for-b2c a 要素を走査し、
 *   隣接テキスト(JAN) + href を取得する
 */
async function extractJanHrefPairs(
  page: Page,
): Promise<Array<{ jan: string; href: string }>> {
  const pairs = await page.evaluate((): Array<{ jan: string; href: string }> => {
    const results: Array<{ jan: string; href: string }> = [];
    const elements = document.querySelectorAll<HTMLAnchorElement>(
      '.product-sku-list .show-for-b2c a',
    );
    elements.forEach((el: HTMLAnchorElement) => {
      let janText = '';
      const next = el.parentElement?.nextElementSibling;
      if (next) {
        janText = next.textContent ?? '';
      }
      results.push({ jan: janText, href: el.getAttribute('href') ?? '' });
    });
    return results;
  });

  return pairs
    .map(({ jan, href }) => {
      // JANテキストから数値部分を抽出: "(JAN 1234567890123)" → "1234567890123"
      const match = jan.match(/\(JAN\s+(\d+)\)/);
      const cleanJan = match ? match[1] : '';
      return { jan: cleanJan, href };
    })
    .filter(({ jan, href }) => jan.length > 0 && href.length > 0);
}

/**
 * WD製品ページからタイトル・価格・ボタンテキストを取得する
 */
async function extractProductDetail(
  detailPage: Page,
): Promise<{ title: string; price: string; buttonText: string; discountPrice: string }> {
  let title = '';
  let price = '';
  let buttonText = '';
  let discountPrice = '-';

  // タイトル
  // h1 全体のテキストから製品型番の接頭辞を除去する
  try {
    const heading = normalizeWhitespace(
      (await detailPage.locator('h1').first().textContent({ timeout: 5000 })) ?? '',
    );
    title = heading.replace(/^製品型番:\s*\S+\s*/u, '').trim();
    if (!title) {
      title = heading;
    }
  } catch { /* 無視 */ }

  // 購入導線テキスト
  const btnSelector = [
    'a.pdp-buy-btn-link',
    'button.salesInquiryModal',
    '.wtbBtbwWithIcon',
    'a[href="#buy-btn"]',
    'button[class*="salesInquiry"]',
  ];

  for (const sel of btnSelector) {
    try {
      const btns = await detailPage.locator(sel).all();
      for (const btn of btns) {
        const txt = (await btn.textContent({ timeout: 2000 }))?.trim() ?? '';
        if (txt && txt !== '') {
          buttonText = txt;
          break;
        }
      }
      if (buttonText) break;
    } catch { /* 次を試す */ }
  }

  if (!buttonText) {
    try {
      const bodyText = normalizeWhitespace((await detailPage.textContent('body')) ?? '');
      const match = bodyText.match(/(購入する|販売店を探す|担当営業へのお問い合わせ)/u);
      if (match) {
        buttonText = match[1];
      }
    } catch { /* 無視 */ }
  }

  // 価格
  // ¥ 記号を含む span/p を探す
  const priceSelectors = [
    '[class*="price"] span',
    'span[class*="price"]',
    'p[class*="price"]',
    '[class*="priceValue"]',
  ];

  for (const sel of priceSelectors) {
    try {
      const els = await detailPage.locator(sel).all();
      for (const el of els) {
        const txt = (await el.textContent({ timeout: 1000 }))?.trim() ?? '';
        if (txt.includes('¥')) {
          price = txt.split('¥')[1]?.split(/[\s\n]/)[0]?.trim() ?? '';
          if (price) break;
        }
      }
      if (price) break;
    } catch { /* 次を試す */ }
  }

  if (!price || price === '-') {
    price = (await extractPriceFromApi(detailPage)) || price;
  }

  if (!price || price === '-') {
    price = (await extractPriceFromStructuredData(detailPage)) || price;
  }

  if (!price) {
    price = '-';
  }

  // 割引価格 (PAD では "Actual" を含む場合に別の要素から取得)
  if (price.toLowerCase().includes('actual')) {
    // 割引表示の場合、別要素から定価を取得
    try {
      const discountEl = detailPage.locator('[class*="discount"], [class*="original-price"]').first();
      const txt = (await discountEl.textContent({ timeout: 2000 }))?.trim() ?? '';
      discountPrice = txt.includes('¥') ? (txt.split('¥')[1]?.split(/[\s\n]/)[0]?.trim() ?? '-') : '-';
    } catch { /* 無視 */ }
  }

  return { title, price, buttonText, discountPrice };
}

/**
 * メインのWDスクレイパー関数
 */
export async function scrapeWD(
  context: BrowserContext,
  config: WDConfig,
): Promise<void> {
  const { startUrl, prefix, csvFileName } = config;

  console.log(`\n[WD] スクレイピング開始`);

  const csv = new CsvManager(`${prefix}${csvFileName}`);
  let row = csv.getRowCount() + 1;
  let aborted = false;
  const processedJans = new Set(csv.getColumnValues(1).filter((value) => value.length > 0));
  const productOffset = Number(process.env.WD_PRODUCT_OFFSET ?? '0');
  const productLimit = Number(process.env.WD_PRODUCT_LIMIT ?? '0');

  const listPage = await context.newPage();
  let detailPage = await context.newPage();

  if (processedJans.size > 0) {
    console.log(`[WD] 既存CSVから再開: ${processedJans.size}件スキップ予定`);
  }

  try {
    // WD製品一覧ページを開く
    await listPage.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await sleep(PAGE_WAIT_MS);

    // Cookie同意ボタン
    // PAD: Button '承諾' (id="truste-consent-button")
    try {
      const consentBtn = listPage.locator('#truste-consent-button, button[id*="consent"]');
      if ((await consentBtn.count()) > 0) {
        await consentBtn.first().click();
        console.log('[WD] Cookie同意 OK');
        await sleep(2000);
      }
    } catch { /* 無視 */ }

    // 製品URLリストを収集
    console.log('[WD] 製品URLリスト収集中...');
    const allProductUrls = await collectProductUrls(listPage);
    const productUrls = applyProductWindow(allProductUrls, productOffset, productLimit);
    console.log(`[WD] 収集URL数: ${productUrls.length}`);

    // 各製品ページでJANコードとバリアントURLを取得
    for (let i = 0; i < productUrls.length; i++) {
      const productUrl = productUrls[i];
      console.log(`[WD] 製品ページ ${i + 1}/${productUrls.length}: ${productUrl}`);

      if (i > 0 && i % PRODUCT_COOLDOWN_EVERY === 0) {
        console.log(`[WD] クールダウン ${PRODUCT_COOLDOWN_MS}ms`);
        await sleep(PRODUCT_COOLDOWN_MS);
      }

      try {
        await retryGoto(detailPage, productUrl, 3);
        await sleep(2000);

        // product-model-number セクションが存在するか確認
        // PAD: div#product-model-number > .show-for-b2c が無い場合はスキップ
        const hasModelSection =
          (await detailPage.locator('#product-model-number .show-for-b2c').count()) > 0;
        if (!hasModelSection) {
          console.log(`[WD]  → モデル番号セクションなし、スキップ`);
          continue;
        }

        // JAN + バリアントURLペアを取得
        const pairs = await extractJanHrefPairs(detailPage);
        if (pairs.length === 0) {
          console.log(`[WD]  → JANペアなし、スキップ`);
          continue;
        }

        console.log(`[WD]  → JANペア ${pairs.length}件`);

        for (const { jan, href } of pairs) {
          if (processedJans.has(jan)) {
            console.log(`[WD]  既存JANのためスキップ: ${jan}`);
            continue;
          }

          const variantUrl = href.startsWith('https')
            ? href
            : `https://www.westerndigital.com${href}`;

          console.log(`[WD]  バリアント: ${jan} | ${variantUrl}`);

          try {
            // ランダム待機 (0〜3秒) - PAD 同等のボット対策
            await sleep(Math.random() * VARIANT_DELAY_MAX_MS);

            await retryGoto(detailPage, variantUrl, 3);
            const { title, price, buttonText, discountPrice } = await extractProductDetail(detailPage);

            const item: WDItem = {
              jan,
              title,
              price,
              buttonText,
              discountPrice,
              crawledAt: new Date(),
            };

            csv.writeCell(row, 1, item.jan);
            csv.writeCell(row, 2, item.title);
            csv.writeCell(row, 3, item.price);
            csv.writeCell(row, 4, item.buttonText);
            csv.writeCell(row, 5, item.discountPrice);
            csv.writeCell(row, 6, item.crawledAt);
            row++;
            await csv.save();
            processedJans.add(jan);

            console.log(`[WD]  ✓ ${title.substring(0, 40)} | ¥${price}`);
          } catch (e) {
            if (isPageCrashedError(e)) {
              console.warn(`[WD]  ページクラッシュを検知したため復旧: ${variantUrl}`);
              detailPage = await recreateDetailPage(context, detailPage);
              await sleep(NAVIGATION_BACKOFF_MS);
              continue;
            }
            if (isBrowserClosedError(e)) {
              aborted = true;
              console.warn(`[WD]  ブラウザ終了を検知したため中断: ${variantUrl}`);
              break;
            }
            console.warn(`[WD]  バリアント取得エラー (${variantUrl}): ${e}`);
          }

          if (aborted) break;
          await sleep(ITEM_WAIT_MS);
        }

      } catch (e) {
        if (isPageCrashedError(e)) {
          console.warn(`[WD] ページクラッシュを検知したため復旧: ${productUrl}`);
          detailPage = await recreateDetailPage(context, detailPage);
          await sleep(NAVIGATION_BACKOFF_MS);
          continue;
        }
        if (isBrowserClosedError(e)) {
          aborted = true;
          console.warn(`[WD] ブラウザ終了を検知したため中断: ${productUrl}`);
          break;
        }
        console.warn(`[WD] 製品ページエラー (${productUrl}): ${e}`);
      }

      if (aborted) break;
    }

  } finally {
    await csv.save();
    await listPage.close();
    await detailPage.close();
  }

  console.log(`[WD] 完了 (${row - 1}件)`);
}

// ---- ヘルパー ----

async function retryGoto(page: Page, url: string, retries: number): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return;
    } catch (e) {
      if (i === retries - 1) throw e;

      const backoff = isTimeoutError(e) ? NAVIGATION_BACKOFF_MS : 2000;
      console.warn(`[WD] 遷移再試行 ${i + 1}/${retries - 1}: ${url} (${String(e)})`);
      await sleep(backoff);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isBrowserClosedError(error: unknown): boolean {
  return String(error).includes('Target page, context or browser has been closed');
}

function isPageCrashedError(error: unknown): boolean {
  return String(error).includes('Page crashed');
}

function isTimeoutError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes('timeout') || message.includes('timed out') || message.includes('net::err');
}

async function recreateDetailPage(context: BrowserContext, currentPage: Page): Promise<Page> {
  try {
    await currentPage.close();
  } catch {
    // クラッシュ済みページは close 失敗でも無視
  }

  return context.newPage();
}

async function extractPriceFromStructuredData(page: Page): Promise<string> {
  try {
    const currentUrl = page.url();
    const currentSku = new URL(currentUrl).searchParams.get('sku') ?? '';
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();

    for (const scriptText of scripts) {
      const parsed = safeJsonParse(scriptText);
      if (!parsed) continue;

      const price = findPriceInStructuredData(parsed, currentSku, currentUrl);
      if (price) {
        return price;
      }
    }
  } catch {
    // structured data が無くても継続
  }

  return '';
}

async function extractPriceFromApi(page: Page): Promise<string> {
  try {
    const currentUrl = page.url();
    const sku = new URL(currentUrl).searchParams.get('sku') ?? '';
    if (!sku) {
      return '';
    }

    const price = await page.evaluate(async (currentSku) => {
      const response = await fetch(
        `/ja-jp/store/cart/guest/products/priceAndInventory?fields=FULL&productsQuery=${encodeURIComponent(currentSku)}`,
        {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
      );

      if (!response.ok) {
        return '';
      }

      const data = await response.json() as Array<{
        code?: string;
        priceData?: { formattedValue?: string; value?: number | string } | null;
        discountPriceData?: { formattedValue?: string; value?: number | string } | null;
      }>;

      const item = data.find((entry) => entry.code === currentSku);
      const priceCandidate = item?.discountPriceData ?? item?.priceData;
      if (!priceCandidate) {
        return '';
      }

      if (typeof priceCandidate.formattedValue === 'string' && priceCandidate.formattedValue.length > 0) {
        return priceCandidate.formattedValue.replace(/[￥¥,\s]/g, '').trim();
      }

      if (typeof priceCandidate.value === 'number') {
        return Math.round(priceCandidate.value).toLocaleString('ja-JP');
      }

      if (typeof priceCandidate.value === 'string') {
        const numeric = Number(priceCandidate.value);
        return Number.isFinite(numeric) ? Math.round(numeric).toLocaleString('ja-JP') : '';
      }

      return '';
    }, sku);

    return price;
  } catch {
    return '';
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findPriceInStructuredData(data: unknown, sku: string, url: string): string {
  if (!data) return '';

  if (Array.isArray(data)) {
    for (const item of data) {
      const price = findPriceInStructuredData(item, sku, url);
      if (price) return price;
    }
    return '';
  }

  if (typeof data !== 'object') {
    return '';
  }

  const record = data as Record<string, unknown>;
  const recordSku = typeof record.sku === 'string' ? record.sku : '';
  const recordUrl = typeof record.url === 'string' ? record.url : '';
  const isMatch = (sku && recordSku === sku) || (recordUrl && url.endsWith(recordUrl));

  if (isMatch) {
    const offerPrice = extractOfferPrice(record.offers);
    if (offerPrice) {
      return offerPrice;
    }
  }

  for (const value of Object.values(record)) {
    const price = findPriceInStructuredData(value, sku, url);
    if (price) return price;
  }

  return '';
}

function extractOfferPrice(offers: unknown): string {
  if (!offers) return '';

  if (Array.isArray(offers)) {
    for (const offer of offers) {
      const price = extractOfferPrice(offer);
      if (price) return price;
    }
    return '';
  }

  if (typeof offers !== 'object') {
    return '';
  }

  const record = offers as Record<string, unknown>;
  const value = record.price;
  if (typeof value === 'number') {
    return formatYenPrice(value);
  }
  if (typeof value === 'string' && value.trim()) {
    return formatYenPrice(Number(value));
  }

  return '';
}

function formatYenPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  return Math.round(value).toLocaleString('ja-JP');
}

function applyProductWindow(urls: string[], offset: number, limit: number): string[] {
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const sliced = urls.slice(safeOffset);

  if (!Number.isFinite(limit) || limit <= 0) {
    return sliced;
  }

  return sliced.slice(0, limit);
}

function isProductDetailUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!url.pathname.includes('/products/')) {
      return false;
    }

    if (url.searchParams.has('sku')) {
      return true;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 5) {
      return false;
    }

    const leaf = parts[parts.length - 1];
    const excludedLeaves = new Set([
      'products',
      'hdd',
      'data-center-storage',
      'network-attached-storage',
      'accessories',
      'weekly-sale',
      'clearance',
    ]);

    return !excludedLeaves.has(leaf);
  } catch {
    return false;
  }
}
