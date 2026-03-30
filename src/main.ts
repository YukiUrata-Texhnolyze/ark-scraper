/**
 * メインエントリーポイント
 *
 * PAD「Main」フローの移植版。
 * 実行順序: tek → pside → Amazon → WD_copy
 * エラー発生時: エラーメール送信
 * 出力形式: CSV
 *
 * 使用方法:
 *   npx ts-node src/main.ts          # 全スクレイパー実行
 *   npx ts-node src/main.ts tek      # tekのみ
 *   npx ts-node src/main.ts pside    # psideのみ
 *   npx ts-node src/main.ts amazon   # Amazonのみ
 *   npx ts-node src/main.ts wd       # WDのみ
 */

import 'dotenv/config';
import { chromium, Browser, BrowserContext } from 'playwright';
import { scrapeRakuten } from './scrapers/rakuten';
import { scrapeAmazon } from './scrapers/amazon';
import { scrapeWD } from './scrapers/wd';
import { sendErrorEmail } from './utils/mailer';
import { isSharePointUploadConfigured, uploadFilesToSharePointIfConfigured } from './utils/sharepoint';
import { RakutenConfig, AmazonConfig, WDConfig } from './types';
import fs from 'fs';
import path from 'path';

// =====================================================
// 設定定数
// =====================================================

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';
const RUN_TIMESTAMP = formatOutputTimestamp(new Date());
const OUTPUT_FILE_NAME = `${RUN_TIMESTAMP}.csv`;

const TEK_CONFIG: RakutenConfig = {
  shopId: '412157',
  prefix: 'tek_',
  csvFileName: OUTPUT_FILE_NAME,
};

const PSIDE_CONFIG: RakutenConfig = {
  shopId: '413243',
  prefix: 'pside_',
  csvFileName: OUTPUT_FILE_NAME,
};

const AMAZON_CONFIG: AmazonConfig = {
  merchantId: 'A290QSZB4BCGSX',
  prefix: 'ama_',
  csvFileName: OUTPUT_FILE_NAME,
};

const WD_CONFIG: WDConfig = {
  // PAD では /products から開始し、product-sku-list を持つページを収集
  startUrl: 'https://www.westerndigital.com/ja-jp/products',
  prefix: 'WD_',
  csvFileName: OUTPUT_FILE_NAME,
};

// =====================================================
// メイン処理
// =====================================================

async function main(): Promise<void> {
  const targets = getTargets();
  const headless = process.env.HEADLESS !== 'false';
  let browser: Browser | null = null;
  const generatedFiles: string[] = [];

  try {
    for (const target of targets) {
      const context = await createContextForTarget(target, headless, async () => {
        if (!browser) {
          browser = await chromium.launch({
            headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          });
        }

        return browser;
      });

      try {
        if (target === 'tek') {
          await scrapeRakuten(context, { ...TEK_CONFIG, csvFileName: OUTPUT_FILE_NAME });
          generatedFiles.push(getOutputFilePath(TEK_CONFIG.prefix, OUTPUT_FILE_NAME));
        } else if (target === 'pside') {
          await scrapeRakuten(context, { ...PSIDE_CONFIG, csvFileName: OUTPUT_FILE_NAME });
          generatedFiles.push(getOutputFilePath(PSIDE_CONFIG.prefix, OUTPUT_FILE_NAME));
        } else if (target === 'amazon') {
          await scrapeAmazon(context, AMAZON_CONFIG);
          generatedFiles.push(getOutputFilePath(AMAZON_CONFIG.prefix, OUTPUT_FILE_NAME));
        } else if (target === 'wd') {
          await scrapeWD(context, WD_CONFIG);
          generatedFiles.push(getOutputFilePath(WD_CONFIG.prefix, OUTPUT_FILE_NAME));
        }
      } finally {
        await context.close();
      }
    }

    await uploadFilesToSharePointIfConfigured(generatedFiles);

    if (isSharePointUploadConfigured()) {
      await clearOutputDirectoryContents(OUTPUT_DIR);
    }

    console.log('\n==== 全スクレイパー完了 ====');
    console.log(`出力先: ${OUTPUT_DIR}`);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[ERROR] ${message}`);

    // PAD「エラーメール送信」フローに相当
    try {
      await sendErrorEmail(message);
    } catch (mailError) {
      console.error('[ERROR] メール送信失敗:', mailError);
    }

    process.exit(1);
  } finally {
    if (browser) {
      await (browser as Browser).close();
    }
  }
}

function getOutputFilePath(prefix: string, fileName: string): string {
  return path.resolve(OUTPUT_DIR, `${prefix}${fileName}`);
}

async function clearOutputDirectoryContents(outputDir: string): Promise<void> {
  const resolvedOutputDir = path.resolve(outputDir);
  if (!fs.existsSync(resolvedOutputDir)) {
    return;
  }

  const entries = await fs.promises.readdir(resolvedOutputDir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(resolvedOutputDir, entry.name);
    await fs.promises.rm(entryPath, { recursive: true, force: true });
  }));

  console.log(`[Output] 掃除完了: ${resolvedOutputDir}`);
}

function formatOutputTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

async function createContextForTarget(
  target: string,
  headless: boolean,
  getBrowser: () => Promise<Browser>,
): Promise<BrowserContext> {
  if (target === 'amazon') {
    const userDataDir = process.env.AMAZON_PERSISTENT_USER_DATA_DIR;
    if (userDataDir) {
      console.log(`[Amazon] 永続プロファイルを使用: ${userDataDir}`);
      return chromium.launchPersistentContext(userDataDir, {
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        viewport: { width: 1920, height: 1080 },
        colorScheme: 'light',
      });
    }
  }

  const browser = await getBrowser();
  return browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1920, height: 1080 },
    colorScheme: 'light',
  });
}

/**
 * コマンドライン引数からターゲットを取得する
 * 引数なし → 全スクレイパー実行 (tek → pside → amazon → wd)
 */
function getTargets(): string[] {
  const args = process.argv.slice(2);
  const valid = ['tek', 'pside', 'amazon', 'wd'];

  if (args.length === 0) {
    return [...valid]; // 全実行
  }

  const invalid = args.filter((a) => !valid.includes(a));
  if (invalid.length > 0) {
    console.error(`不正な引数: ${invalid.join(', ')}`);
    console.error(`有効な引数: ${valid.join(', ')}`);
    process.exit(1);
  }

  return args;
}

main();
