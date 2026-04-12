/**
 * 楽天市場スクレイパー (tek店 / pside店 共通)
 *
 * PADフロー「tek」「pside」の移植版。
 * 収集カラム:
 *   A列(1): JANコード
 *   B列(2): 商品名
 *   C列(3): 価格 (円 より前)
 *   D列(4): ポイント (pt より前)
 *   E列(5): クロール日時
 *   F列(6): 売り切れ (該当時)
 *   G列(7): バリエーション有り (該当時)
 *
 * 楽天検索URL例: https://search.rakuten.co.jp/search/mall/?f=0&sid=412157
 *   - input[name="pd"] チェック = 「商品価格＋送料−獲得予定ポイント」表示
 *   - i[title="詳細"] クリック = 詳細リストビュー
 *
 * セレクター翻訳メモ:
 *   PAD `:eq(n)` (0始まり) → CSS `:nth-of-type(n+1)` (1始まり)
 */

import { BrowserContext, Page } from 'playwright';
import { CsvManager } from '../utils/csv';
import { RakutenConfig, RakutenItem } from '../types';

const ITEM_WAIT_MS = 400;
const JAN_FETCH_CONCURRENCY = 4;
const RAKUTEN_TRANSITION_TIMEOUT_MS = 5000;
const RAKUTEN_RESULTS_SELECTOR = '.searchresultitem';
const LIST_PAGE_BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);
const DETAIL_PAGE_BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);
const RAKUTEN_DETAIL_FETCH_TIMEOUT_MS = 20000;
const RAKUTEN_DETAIL_FETCH_RETRIES = 2;
const RAKUTEN_DETAIL_REQUEST_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};

type RakutenPendingItem = Omit<RakutenItem, 'jan'> & {
  itemIndex: number;
  itemTotal: number;
};

type RakutenListItemSnapshot = {
  title: string;
  url: string;
  price: string;
  points: string;
  soldout: boolean;
  hasVariation: boolean;
};

type RakutenListExtractionResult = {
  pendingItems: RakutenPendingItem[];
  listedItemCount: number;
  listExtractionMs: number;
};

type RakutenPageExtractionResult = {
  items: RakutenItem[];
  listedItemCount: number;
  extractedItemCount: number;
  listExtractionMs: number;
  janFetchMs: number;
};

/**
 * 楽天商品1ページ分のアイテムを抽出する。
 * 詳細ビュー (v=2 相当) が前提。
 */
async function extractItemsOnPage(
  listPage: Page,
  detailPages: Page[],
  shopId: string,
): Promise<RakutenPageExtractionResult> {
  const { pendingItems, listedItemCount, listExtractionMs } = await extractPendingItemsOnPage(listPage);
  const janFetchStartedAt = Date.now();
  const items = await mapWithConcurrency(
    pendingItems,
    Math.min(JAN_FETCH_CONCURRENCY, detailPages.length),
    async (item, _index, workerIndex) => {
      let jan = '未セット';

      try {
        jan = await fetchRakutenJan(item.url, RAKUTEN_DETAIL_FETCH_RETRIES);
        if (jan === '未セット') {
          await retryGoto(detailPages[workerIndex], item.url, 2);
          jan = await extractJan(detailPages[workerIndex]);
        }
      } catch (fetchError) {
        try {
          await retryGoto(detailPages[workerIndex], item.url, 2);
          jan = await extractJan(detailPages[workerIndex]);
        } catch (browserError) {
          console.warn(`[Rakuten] JAN取得失敗 (${item.url}): HTTP=${fetchError} Browser=${browserError}`);
        }
      }

      console.log(
        `[Rakuten:${shopId}] (${item.itemIndex + 1}/${item.itemTotal}) ${item.title.substring(0, 50)} | JAN:${jan}`,
      );
      await sleep(ITEM_WAIT_MS);

      return {
        jan,
        title: item.title,
        price: item.price,
        points: item.points,
        url: item.url,
        soldout: item.soldout,
        hasVariation: item.hasVariation,
        crawledAt: item.crawledAt,
      };
    },
  );

  return {
    items,
    listedItemCount,
    extractedItemCount: pendingItems.length,
    listExtractionMs,
    janFetchMs: Date.now() - janFetchStartedAt,
  };
}

async function extractPendingItemsOnPage(listPage: Page): Promise<RakutenListExtractionResult> {
  const listExtractionStartedAt = Date.now();

  try {
    await listPage.waitForSelector(RAKUTEN_RESULTS_SELECTOR, { timeout: 15000 });

    const itemSnapshots: RakutenListItemSnapshot[] = await listPage
      .locator(RAKUTEN_RESULTS_SELECTOR)
      .evaluateAll((elements) => elements.map((element) => {
        const root = element as HTMLElement;
        const titleAnchor = root.querySelector('h2 a') as HTMLAnchorElement | null;
        const title = titleAnchor?.textContent?.trim() ?? '';
        const url = titleAnchor?.href ?? '';
        const priceText = (root.querySelector('[class*="price-wrapper"]')?.textContent ?? '').trim();
        const dataPrice = root.querySelector('[data-price]')?.getAttribute('data-price')?.trim() ?? '';
        const pointsText = (root.querySelector('[class*="points--"] span')?.textContent ?? '').trim();
        const itemText = root.textContent ?? '';

        return {
          title,
          url,
          price: dataPrice || priceText.split('円')[0].replace(/,/g, '').trim(),
          points: pointsText.split('ポイント')[0].trim(),
          soldout: itemText.includes('売り切れ')
            || itemText.includes('SOLD OUT')
            || root.querySelector('[class*="soldout"]') !== null,
          hasVariation: priceText.includes('〜'),
        };
      }));

    const listedItemCount = itemSnapshots.length;
    const crawledAt = new Date();
    const pendingItems = itemSnapshots.flatMap((item, itemIndex) => {
      if (!item.title || !item.url) {
        return [];
      }

      return [{
        ...item,
        crawledAt,
        itemIndex,
        itemTotal: listedItemCount,
      }];
    });

    return {
      pendingItems,
      listedItemCount,
      listExtractionMs: Date.now() - listExtractionStartedAt,
    };
  } catch {
    console.warn('[Rakuten] .searchresultitem が見つかりませんでした。');
    return {
      pendingItems: [],
      listedItemCount: 0,
      listExtractionMs: Date.now() - listExtractionStartedAt,
    };
  }
}

/**
 * メインのRakutenスクレイパー関数
 */
export async function scrapeRakuten(
  context: BrowserContext,
  config: RakutenConfig,
): Promise<void> {
  const { shopId, prefix, csvFileName } = config;
  const startUrl = `https://search.rakuten.co.jp/search/mall/?f=0&sid=${shopId}`;

  console.log(`\n[Rakuten:${shopId}] スクレイピング開始`);

  const csv = new CsvManager(`${prefix}${csvFileName}`);
  let row = 1;
  const seenItemUrls = new Set<string>();

  const listPage = await context.newPage();
  const detailPages = await Promise.all(
    Array.from({ length: JAN_FETCH_CONCURRENCY }, () => context.newPage()),
  );

  await configureRakutenPage(listPage, LIST_PAGE_BLOCKED_RESOURCE_TYPES);
  await Promise.all(detailPages.map((detailPage) => configureRakutenPage(detailPage, DETAIL_PAGE_BLOCKED_RESOURCE_TYPES)));

  try {
    // ページを開く (キャッシュなし)
    await listPage.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await waitForRakutenResultsReady(listPage);

    // 「商品価格＋送料−獲得予定ポイント」表示チェックボックスをON
    // PAD: Input checkbox 'pd'
    try {
      const pdCheckbox = listPage.locator('input[name="pd"]');
      if (await pdCheckbox.count() > 0) {
        const isChecked = await pdCheckbox.isChecked();
        if (!isChecked) {
          const previousState = await captureRakutenListState(listPage);
          await pdCheckbox.click();
          console.log(`[Rakuten:${shopId}] 最終価格表示 ON`);
          await waitForRakutenResultsReady(listPage, previousState);
        }
      }
    } catch (e) {
      console.warn(`[Rakuten:${shopId}] pd checkbox スキップ: ${e}`);
    }

    // 詳細ビューに切替
    // PAD: Idiomatic text '詳細' (title="詳細")
    try {
      const detailBtn = listPage.locator('i[title="詳細"]');
      if (await detailBtn.count() > 0) {
        const previousState = await captureRakutenListState(listPage);
        await detailBtn.click();
        await listPage.waitForLoadState('domcontentloaded');
        console.log(`[Rakuten:${shopId}] 詳細ビューに切替`);
        await waitForRakutenResultsReady(listPage, previousState);
      }
    } catch (e) {
      console.warn(`[Rakuten:${shopId}] 詳細ビュー切替スキップ: ${e}`);
    }

    // --- ページネーションループ ---
    let pageNum = 1;
    while (true) {
      console.log(`[Rakuten:${shopId}] ページ ${pageNum} 取得中...`);
      const pageStartedAt = Date.now();
      const pageResult = await extractItemsOnPage(listPage, detailPages, shopId);
      const uniqueItems = pageResult.items.filter((item) => {
        const key = item.url.trim();
        if (!key) {
          return true;
        }

        if (seenItemUrls.has(key)) {
          return false;
        }

        seenItemUrls.add(key);
        return true;
      });

      const skippedDuplicates = pageResult.items.length - uniqueItems.length;
      if (skippedDuplicates > 0) {
        console.log(`[Rakuten:${shopId}] ページ ${pageNum}: 重複商品を ${skippedDuplicates} 件スキップ`);
      }

      console.log(
        `[Rakuten:${shopId}] ページ ${pageNum}: list=${formatElapsedMs(pageResult.listExtractionMs)} jan=${formatElapsedMs(pageResult.janFetchMs)} total=${formatElapsedMs(Date.now() - pageStartedAt)} items=${uniqueItems.length}/${pageResult.extractedItemCount}/${pageResult.listedItemCount}`,
      );

      for (const item of uniqueItems) {
        csv.writeCell(row, 1, item.jan);
        csv.writeCell(row, 2, item.title);
        csv.writeCell(row, 3, item.price);
        csv.writeCell(row, 4, item.points);
        csv.writeCell(row, 5, item.crawledAt);
        if (item.soldout) csv.writeCell(row, 6, '売り切れ');
        if (item.hasVariation) csv.writeCell(row, 7, 'バリエーション有り');
        row++;
      }

      // 次のページへ
      // PAD: Anchor '次のページ' (class="item -next nextPage")
      const nextBtn = listPage.locator('a.nextPage, a[class*="-next"]').filter({ hasText: '次のページ' });
      const hasNext = await nextBtn.count() > 0;
      if (!hasNext) {
        console.log(`[Rakuten:${shopId}] 最終ページ到達`);
        break;
      }

      const previousState = await captureRakutenListState(listPage);
      const nextPageTransitionStartedAt = Date.now();
      await nextBtn.first().click();
      await listPage.waitForLoadState('domcontentloaded');
      await waitForRakutenResultsReady(listPage, previousState);
      console.log(`[Rakuten:${shopId}] ページ ${pageNum} -> ${pageNum + 1} 遷移 ${formatElapsedMs(Date.now() - nextPageTransitionStartedAt)}`);
      pageNum++;
    }

  } finally {
    await csv.save();
    await listPage.close();
    await Promise.all(detailPages.map((detailPage) => detailPage.close()));
  }

  console.log(`[Rakuten:${shopId}] 完了 (${row - 1}件)`);
}

// ---- ヘルパー ----

async function retryGoto(page: Page, url: string, retries: number): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000);
    }
  }
}

async function extractJan(page: Page): Promise<string> {
  const janFromMeta = await page.locator('meta[itemprop="gtin13"]').getAttribute('content').catch(() => null);
  if (janFromMeta?.trim()) {
    return janFromMeta.trim().substring(0, 13);
  }

  const source = await page.content();
  return extractJanFromHtml(source);
}

async function fetchRakutenJan(url: string, retries: number): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: RAKUTEN_DETAIL_REQUEST_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(RAKUTEN_DETAIL_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`status=${response.status}`);
      }

      const html = await response.text();
      return extractJanFromHtml(html);
    } catch (error) {
      if (attempt === retries - 1) {
        throw error;
      }

      await sleep(500 * (attempt + 1));
    }
  }

  return '未セット';
}

function extractJanFromHtml(html: string): string {
  const directMatch = html.match(/<meta[^>]*itemprop=["']gtin13["'][^>]*content=["']([^"']+)/i);
  if (directMatch?.[1]) {
    return directMatch[1].trim().substring(0, 13);
  }

  const reverseOrderMatch = html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*itemprop=["']gtin13["']/i);
  if (reverseOrderMatch?.[1]) {
    return reverseOrderMatch[1].trim().substring(0, 13);
  }

  return '未セット';
}

async function configureRakutenPage(page: Page, blockedResourceTypes: Set<string>): Promise<void> {
  await page.route('**/*', (route) => {
    if (blockedResourceTypes.has(route.request().resourceType())) {
      return route.abort();
    }

    return route.continue();
  });
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapper: (item: TItem, index: number, workerIndex: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async (_value, workerIndex) => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex, workerIndex);
      }
    }),
  );

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatElapsedMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return `${ms}ms`;
}

async function captureRakutenListState(page: Page): Promise<{ url: string; firstTitle: string; itemCount: number }> {
  const firstTitle = await page.locator('.searchresultitem h2 a').first().textContent().catch(() => '');
  const itemCount = await page.locator(RAKUTEN_RESULTS_SELECTOR).count().catch(() => 0);

  return {
    url: page.url(),
    firstTitle: (firstTitle ?? '').trim(),
    itemCount,
  };
}

async function waitForRakutenResultsReady(
  page: Page,
  previousState?: { url: string; firstTitle: string; itemCount: number },
): Promise<void> {
  try {
    await page.waitForSelector(RAKUTEN_RESULTS_SELECTOR, {
      state: 'visible',
      timeout: RAKUTEN_TRANSITION_TIMEOUT_MS,
    });

    if (!previousState) {
      return;
    }

    await page.waitForFunction(
      ({ selector, previousUrl, previousFirstTitle, previousItemCount }) => {
        const items = Array.from(document.querySelectorAll(selector));
        if (items.length === 0) {
          return false;
        }

        const currentFirstTitle = (document.querySelector('.searchresultitem h2 a')?.textContent ?? '').trim();
        const urlChanged = window.location.href !== previousUrl;
        const titleChanged = Boolean(currentFirstTitle) && currentFirstTitle !== previousFirstTitle;
        const countChanged = items.length !== previousItemCount;

        return urlChanged || titleChanged || countChanged;
      },
      {
        selector: RAKUTEN_RESULTS_SELECTOR,
        previousUrl: previousState.url,
        previousFirstTitle: previousState.firstTitle,
        previousItemCount: previousState.itemCount,
      },
      { timeout: RAKUTEN_TRANSITION_TIMEOUT_MS },
    ).catch(() => undefined);
  } catch {
    await sleep(1000);
  }
}
