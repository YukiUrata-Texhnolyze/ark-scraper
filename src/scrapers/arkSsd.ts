import path from 'path';
import { BrowserContext } from 'playwright';
import { ArkSsdConfig, ArkSsdItem } from '../types';
import {
  buildArkRunLabel,
  capturePageArtifacts,
  compactSpaces,
  detectCloudflareBlock,
  ensureDirForFile,
  ensureDirectory,
  normalizeStockLabel,
  parseCouponDiscountYen,
  parsePriceYen,
  parseProductNumber,
  parseSaleEndGuessJst,
  parseSalePeriod,
  parseSsdSpecsFromTags,
  removeCouponText,
  sortArkSsdItems,
  uniqueBy,
  waitForArkChallengeResolution,
  writeCsvRows,
  writeJsonFile,
} from '../utils/arkHelpers';

interface ArkSsdRawItem {
  url: string | null;
  imageUrl: string | null;
  makerText: string;
  productNameText: string;
  productNumberText: string;
  originalPriceText: string;
  finalPriceText: string;
  saleText: string;
  stockText: string;
  specText: string;
  tags: string[];
  couponText: string;
  combinedText: string;
}

export async function scrapeArkSsd(
  context: BrowserContext,
  config: ArkSsdConfig,
): Promise<void> {
  const outputDir = path.resolve(process.env.OUTPUT_DIR ?? './output');
  const csvFilePath = path.join(outputDir, `${config.prefix}${config.csvFileName}`);
  const runLabel = buildArkRunLabel(config.prefix, config.csvFileName);
  const artifactDir = path.resolve(config.artifactRootDir, runLabel);
  const payloadPath = path.join(artifactDir, 'result.json');

  await ensureDirectory(artifactDir);
  await ensureDirForFile(csvFilePath);
  if (config.storageStatePath) {
    await ensureDirForFile(config.storageStatePath);
  }

  console.log(`\n[ARK SSD] スクレイピング開始: ${config.targetUrls.length}件`);

  const page = await context.newPage();
  const allItems: ArkSsdItem[] = [];

  try {
    for (let sourceIndex = 0; sourceIndex < config.targetUrls.length; sourceIndex += 1) {
      const sourceUrl = config.targetUrls[sourceIndex];
      const htmlPath = path.join(artifactDir, `source-${String(sourceIndex + 1).padStart(2, '0')}.html`);
      const screenshotPath = path.join(artifactDir, `source-${String(sourceIndex + 1).padStart(2, '0')}.png`);

      const response = await page.goto(sourceUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.timeoutMs,
      });

      await capturePageArtifacts(page, htmlPath, screenshotPath);

      const title = await page.title();
      const bodyText = (await page.textContent('body')) || '';

      if (detectCloudflareBlock(title, bodyText) || response?.status() === 403) {
        if (!config.headed) {
          throw new Error(
            [
              `Cloudflare によりブロックされました: ${sourceUrl}`,
              `証跡: ${htmlPath} / ${screenshotPath}`,
              'HEADLESS=false で起動し、ブラウザ上で確認完了後に再実行してください。',
            ].join('\n'),
          );
        }

        await waitForArkChallengeResolution(page, config.timeoutMs);
        await capturePageArtifacts(page, htmlPath, screenshotPath);
      }

      const rawItems = await page.$$eval('.item_listbox', (boxes) => {
        const toAbsoluteUrl = (href: string | null): string | null => {
          try {
            return new URL(href || '', window.location.href).toString();
          } catch {
            return null;
          }
        };

        const readTags = (box: Element): string[] => {
          const fromItemTags = Array.from(box.querySelectorAll<HTMLAnchorElement>('.item-tags a'))
            .map((element) => (element.textContent || '').trim())
            .filter(Boolean);
          if (fromItemTags.length > 0) {
            return fromItemTags;
          }

          const fromItemTagLinks = Array.from(box.querySelectorAll<HTMLAnchorElement>('.itemtag a'))
            .map((element) => (element.textContent || '').trim())
            .filter(Boolean);
          if (fromItemTagLinks.length > 0) {
            return fromItemTagLinks;
          }

          const plainItemTagText = (box.querySelector('.itemtag')?.textContent || '').trim();
          return plainItemTagText ? [plainItemTagText] : [];
        };

        return boxes.map((box) => {
          const anchor = box.querySelector<HTMLAnchorElement>('a[href^="/i/"]');
          const imageElement = box.querySelector<HTMLImageElement>('img.item-img') || box.querySelector<HTMLImageElement>('img');
          const imageUrl = imageElement?.getAttribute('data-original')
            || imageElement?.getAttribute('data-src')
            || imageElement?.getAttribute('src')
            || '';

          const makerText = box.querySelector('.manufacturer a')?.textContent
            || box.querySelector('.manufacturer')?.textContent
            || box.querySelector('.brand a')?.textContent
            || box.querySelector('.brand')?.textContent
            || box.querySelector('.brand_series .brand a')?.textContent
            || '';

          const productNameText = box.querySelector('.itemname1 a')?.textContent
            || box.querySelector('.itemname1')?.textContent
            || '';

          const productNumberText = box.querySelector('.modelnum')?.textContent || '';
          const finalPriceText = box.querySelector('.price_box .price')?.textContent
            || box.querySelector('.price_box_2 .price')?.textContent
            || box.querySelector('.price_box_2')?.textContent
            || box.querySelector('.price_box')?.textContent
            || '';
          const originalPriceText = box.querySelector('.real_price_box .real_price')?.textContent || '';
          const saleText = box.querySelector('.date-diff2')?.textContent || '';
          const stockText = box.querySelector('.nouki-msg')?.textContent || '';
          const couponText = box.querySelector('.price_diff_2.auto_coupon p')?.textContent
            || box.querySelector('.price_diff_2.auto_coupon')?.textContent
            || '';
          const specText = box.querySelector('.itemname2')?.textContent || '';
          const tags = readTags(box);

          return {
            url: toAbsoluteUrl(anchor?.getAttribute('href') || ''),
            imageUrl: toAbsoluteUrl(imageUrl),
            makerText,
            productNameText,
            productNumberText,
            originalPriceText,
            finalPriceText,
            saleText,
            stockText,
            specText,
            tags,
            couponText,
            combinedText: [
              makerText,
              productNameText,
              productNumberText,
              originalPriceText,
              finalPriceText,
              couponText,
              saleText,
              stockText,
              specText,
              tags.join(' '),
            ].join(' '),
          };
        });
      });

      const items = rawItems
        .filter((item): item is ArkSsdRawItem & { url: string } => Boolean(item.url))
        .map<ArkSsdItem>((item) => {
          const combinedText = compactSpaces(item.combinedText);
          const couponDiscountYen = parseCouponDiscountYen(item.couponText || combinedText);
          const finalPriceBaseText = item.finalPriceText || removeCouponText(combinedText, item.couponText);
          const { priceYen: finalPriceYen, priceRaw } = parsePriceYen(finalPriceBaseText);
          const { priceYen: originalPriceYenRaw } = parsePriceYen(item.originalPriceText || '');
          const originalPriceYen = originalPriceYenRaw ?? finalPriceYen;
          const finalPriceWithCoupon =
            Number.isFinite(finalPriceYen) && Number.isFinite(couponDiscountYen)
              ? Math.max(0, (finalPriceYen as number) - (couponDiscountYen as number))
              : finalPriceYen;
          const salePeriod = parseSalePeriod(item.saleText || combinedText);
          const stockState = normalizeStockLabel(item.stockText);
          const ssdSpecs = parseSsdSpecsFromTags(item.tags, item.specText || combinedText);

          return {
            url: item.url,
            sourceUrl,
            imageUrl: item.imageUrl || null,
            productNumber: parseProductNumber(item.productNumberText || combinedText, item.url),
            makerName: compactSpaces(item.makerText) || null,
            productName: compactSpaces(item.productNameText) || null,
            priceYen: finalPriceWithCoupon,
            priceRaw,
            originalPriceYen,
            finalPriceYen: finalPriceWithCoupon,
            inStock: stockState.inStock,
            inStockLabel: stockState.inStockLabel,
            stockStatus: stockState.stockStatus,
            salePeriodRaw: salePeriod.salePeriodRaw,
            saleStart: salePeriod.saleStart,
            saleEnd: salePeriod.saleEnd,
            saleEndGuessJst: parseSaleEndGuessJst(item.saleText),
            capacityGb: ssdSpecs.capacityGb,
            capacityText: ssdSpecs.capacityText,
            interfaceText: ssdSpecs.interfaceText,
            formFactor: ssdSpecs.formFactor,
            tagsText: ssdSpecs.tagsText,
          };
        });

      allItems.push(...items);
      console.log(`[ARK SSD] source=${sourceIndex + 1}/${config.targetUrls.length} items=${items.length}`);
    }

    const sortedItems = sortArkSsdItems(uniqueBy(allItems, (item) => item.url));
    if (sortedItems.length === 0) {
      throw new Error(
        [
          '商品抽出が0件でした。ページ構造変更やブロックの可能性があります。',
          `証跡: ${artifactDir}`,
        ].join('\n'),
      );
    }

    await writeJsonFile(payloadPath, {
      scrapedAt: new Date().toISOString(),
      sourceUrls: config.targetUrls,
      count: sortedItems.length,
      items: sortedItems,
      artifacts: {
        artifactDir,
        ...(config.storageStatePath ? { storageStatePath: config.storageStatePath } : {}),
      },
      notes: {
        cloudflare: 'ブロックされる場合があります。初回は HEADLESS=false での確認が必要なことがあります。',
      },
    });

    await writeCsvRows(csvFilePath, buildCsvRows(sortedItems));

    if (config.storageStatePath) {
      await context.storageState({ path: config.storageStatePath });
      console.log(`[ARK SSD] storage state 保存: ${config.storageStatePath}`);
    }

    console.log(`[ARK SSD] 完了: ${sortedItems.length}件`);
    console.log(`[ARK SSD] CSV: ${csvFilePath}`);
    console.log(`[ARK SSD] Artifacts: ${artifactDir}`);

    if (config.debug) {
      console.log('[ARK SSD] debug sample (first 3)');
      for (const item of sortedItems.slice(0, 3)) {
        console.log({
          sourceUrl: item.sourceUrl,
          url: item.url,
          productNumber: item.productNumber,
          makerName: item.makerName,
          productName: item.productName,
          finalPriceYen: item.finalPriceYen,
          capacityText: item.capacityText,
          capacityGb: item.capacityGb,
          interfaceText: item.interfaceText,
          formFactor: item.formFactor,
          inStockLabel: item.inStockLabel,
        });
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

function buildCsvRows(items: ArkSsdItem[]): Array<Array<unknown>> {
  return [
    ['商品番号', 'メーカー名', '商品名', '商品画像URL', '元価格(円)', '最終価格(円)', '在庫', 'セール期間', 'セール終了推定(JST)', '容量(GB)', '容量(表示)', 'インターフェース', 'フォームファクタ', 'タグ', 'URL', '取得元URL'],
    ...items.map((item) => [
      item.productNumber,
      item.makerName,
      item.productName,
      item.imageUrl,
      item.originalPriceYen,
      item.finalPriceYen,
      item.inStockLabel,
      item.salePeriodRaw,
      item.saleEndGuessJst,
      item.capacityGb,
      item.capacityText,
      item.interfaceText,
      item.formFactor,
      item.tagsText,
      item.url,
      item.sourceUrl,
    ]),
  ];
}