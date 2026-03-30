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

const ITEM_WAIT_MS = 1500;
const RAKUTEN_TRANSITION_TIMEOUT_MS = 5000;
const RAKUTEN_RESULTS_SELECTOR = '.searchresultitem';

/**
 * 楽天商品1ページ分のアイテムを抽出する。
 * 詳細ビュー (v=2 相当) が前提。
 */
async function extractItemsOnPage(
  listPage: Page,
  detailPage: Page,
  shopId: string,
): Promise<RakutenItem[]> {
  const results: RakutenItem[] = [];

  // ---------------------------------------------------------
  // アイテムコンテナを取得
  // PAD: html > body > div:eq(0) > div:eq(2) > div:eq(1) > div:eq(4) > div > div > div
  //   → ここまでがコンテナ、その直下の各 div が1商品
  // ---------------------------------------------------------
  // ---------------------------------------------------------
  // .searchresultitem で全商品要素を取得
  // ---------------------------------------------------------
  let itemLocators;
  try {
    await listPage.waitForSelector('.searchresultitem', { timeout: 15000 });
    itemLocators = await listPage.locator('.searchresultitem').all();
  } catch {
    console.warn('[Rakuten] .searchresultitem が見つかりませんでした。');
    return results;
  }

  for (let i = 0; i < itemLocators.length; i++) {
    const item = itemLocators[i];

    try {
      // --- 商品タイトル & URL ---
      const titleAnchor = item.locator('h2 a').first();
      const title = (await titleAnchor.textContent({ timeout: 3000 }))?.trim() ?? '';
      const url = (await titleAnchor.getAttribute('href', { timeout: 3000 })) ?? '';

      if (!title || !url) continue;

      // --- 価格 ---
      // [class*="price-wrapper"] 内の [class*="price--"] の data-price 属性を優先取得
      // バリエーション商品は価格範囲 "〜" を含む場合がある
      let price = '';
      let hasVariation = false;
      try {
        // data-price 属性 (ポイント表示 div に付与) が最も確実
        const dataPrice = await item.locator('[data-price]').first().getAttribute('data-price', { timeout: 2000 });
        if (dataPrice) {
          price = dataPrice;
        } else {
          // フォールバック: 価格テキストをパース
          const priceDiv = item.locator('[class*="price-wrapper"]').first();
          const priceText = (await priceDiv.textContent({ timeout: 2000 })) ?? '';
          price = priceText.split('円')[0].replace(/,/g, '').trim();
          hasVariation = priceText.includes('〜');
        }
      } catch { /* 価格取得失敗 → 空のまま */ }

      // バリエーション判定: 価格表示に "〜" が含まれるか
      if (!hasVariation) {
        try {
          const priceDiv = item.locator('[class*="price-wrapper"]').first();
          const priceText = (await priceDiv.textContent({ timeout: 1000 })) ?? '';
          hasVariation = priceText.includes('〜');
        } catch { /* 無視 */ }
      }

      // --- ポイント ---
      // [class*="points--"] > span のテキストを "ポイント" で分割
      let points = '';
      try {
        const pointsSpan = item.locator('[class*="points--"] span').first();
        const pointsText = (await pointsSpan.textContent({ timeout: 2000 })) ?? '';
        points = pointsText.split('ポイント')[0].trim();
      } catch { /* ポイント表示なし */ }

      // --- 売り切れ ---
      let soldout = false;
      try {
        const itemText = (await item.textContent({ timeout: 2000 })) ?? '';
        soldout = itemText.includes('売り切れ') || itemText.includes('SOLD OUT') ||
                  (await item.locator('[class*="soldout"]').count()) > 0;
      } catch { /* 無視 */ }

      // --- 商品個別ページでJANコード取得 ---
      let jan = '未セット';
      try {
        await retryGoto(detailPage, url, 3);
        const source = await detailPage.content();
        const parts = source.split('<meta itemprop="gtin13" content="');
        if (parts.length >= 2) {
          jan = parts[1].substring(0, 13);
        }
      } catch (e) {
        console.warn(`[Rakuten] JAN取得失敗 (${url}): ${e}`);
      }

      results.push({
        jan,
        title,
        price,
        points,
        url,
        soldout,
        hasVariation,
        crawledAt: new Date(),
      });

      console.log(`[Rakuten:${shopId}] (${i + 1}/${itemLocators.length}) ${title.substring(0, 50)} | JAN:${jan}`);
      await sleep(ITEM_WAIT_MS);

    } catch (e) {
      console.warn(`[Rakuten] アイテム取得エラー (index ${i}): ${e}`);
    }
  }

  return results;
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

  const listPage = await context.newPage();
  const detailPage = await context.newPage();

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
      const items = await extractItemsOnPage(listPage, detailPage, shopId);

      for (const item of items) {
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
      await nextBtn.first().click();
      await listPage.waitForLoadState('domcontentloaded');
      await waitForRakutenResultsReady(listPage, previousState);
      pageNum++;
    }

  } finally {
    await csv.save();
    await listPage.close();
    await detailPage.close();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
