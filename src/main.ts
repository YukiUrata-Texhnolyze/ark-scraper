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
 *   npx ts-node src/main.ts ark-memory # Ark メモリのみ
 *   npx ts-node src/main.ts ark-ssd    # Ark SSDのみ
 */

import 'dotenv/config';
import { chromium, Browser, BrowserContext } from 'playwright';
import { scrapeArkMemory } from './scrapers/arkMemory';
import { scrapeArkSsd } from './scrapers/arkSsd';
import { scrapeRakuten } from './scrapers/rakuten';
import { scrapeAmazon } from './scrapers/amazon';
import { scrapeWD } from './scrapers/wd';
import { sendErrorEmail } from './utils/mailer';
import { DEFAULT_ARK_USER_AGENT, parseUrlList } from './utils/arkHelpers';
import { isSharePointUploadConfigured, uploadFilesToSharePointIfConfigured } from './utils/sharepoint';
import { uploadFilesToR2IfConfigured, R2UploadFile } from './utils/storageUpload';
import { RakutenConfig, AmazonConfig, WDConfig, ArkMemoryConfig, ArkSsdConfig } from './types';
import fs from 'fs';
import path from 'path';

type ScrapeTarget = 'tek' | 'pside' | 'amazon' | 'wd' | 'ark-memory' | 'ark-ssd';

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
  const sharePointFiles: string[] = [];
  const r2Files: R2UploadFile[] = [];

  const getBrowser = async (): Promise<Browser> => {
    if (!browser) {
      browser = await chromium.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }

    return browser;
  };

  try {
    for (const target of targets) {
      if (target === 'tek') {
        await runWithTargetContext(target, headless, getBrowser, async (context) => {
          await scrapeRakuten(context, { ...TEK_CONFIG, csvFileName: OUTPUT_FILE_NAME });
        });
        sharePointFiles.push(getOutputFilePath(TEK_CONFIG.prefix, OUTPUT_FILE_NAME));
        continue;
      }

      if (target === 'pside') {
        await runWithTargetContext(target, headless, getBrowser, async (context) => {
          await scrapeRakuten(context, { ...PSIDE_CONFIG, csvFileName: OUTPUT_FILE_NAME });
        });
        sharePointFiles.push(getOutputFilePath(PSIDE_CONFIG.prefix, OUTPUT_FILE_NAME));
        continue;
      }

      if (target === 'amazon') {
        await runWithTargetContext(target, headless, getBrowser, async (context) => {
          await scrapeAmazon(context, AMAZON_CONFIG);
        });
        sharePointFiles.push(getOutputFilePath(AMAZON_CONFIG.prefix, OUTPUT_FILE_NAME));
        continue;
      }

      if (target === 'wd') {
        await runWithTargetContext(target, headless, getBrowser, async (context) => {
          await scrapeWD(context, WD_CONFIG);
        });
        sharePointFiles.push(getOutputFilePath(WD_CONFIG.prefix, OUTPUT_FILE_NAME));
        continue;
      }

      if (target === 'ark-memory') {
        const config = createArkMemoryConfig(headless);
        await runWithTargetContext(target, headless, getBrowser, async (context) => {
          await scrapeArkMemory(context, config);
        });
        r2Files.push({
          filePath: getOutputFilePath(config.prefix, config.csvFileName),
          key: resolveArkMemoryR2Key(),
        });
        continue;
      }

      if (target === 'ark-ssd') {
        const config = createArkSsdConfig(headless);
        await runWithTargetContext(target, headless, getBrowser, async (context) => {
          await scrapeArkSsd(context, config);
        });
        r2Files.push({
          filePath: getOutputFilePath(config.prefix, config.csvFileName),
          key: resolveArkSsdR2Key(),
        });
      }
    }

    const sharePointConfigured = isSharePointUploadConfigured();
    await uploadFilesToSharePointIfConfigured(sharePointFiles);
    if (sharePointConfigured) {
      await removeUploadedFiles(sharePointFiles);
    }

    await uploadFilesToR2IfConfigured(r2Files);

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

async function removeUploadedFiles(filePaths: string[]): Promise<void> {
  const existingFiles = filePaths
    .map((filePath) => path.resolve(filePath))
    .filter((filePath, index, array) => array.indexOf(filePath) === index)
    .filter((filePath) => fs.existsSync(filePath));

  if (existingFiles.length === 0) {
    return;
  }

  await Promise.all(existingFiles.map(async (filePath) => {
    await fs.promises.rm(filePath, { force: true });
  }));

  console.log(`[Output] SharePointアップロード済みファイルを削除: ${existingFiles.length}件`);
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
  target: ScrapeTarget,
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

  if (isArkTarget(target)) {
    const browser = await getBrowser();
    const storageStatePath = resolveExistingArkStorageStatePath();

    return browser.newContext({
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1920, height: 1080 },
      colorScheme: 'light',
      ignoreHTTPSErrors: true,
      userAgent: DEFAULT_ARK_USER_AGENT,
      extraHTTPHeaders: {
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    });
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
 * 引数なし → 既存スクレイパーのみ実行 (tek → pside → amazon → wd)
 */
function getTargets(): ScrapeTarget[] {
  const args = process.argv.slice(2);
  const valid: ScrapeTarget[] = ['tek', 'pside', 'amazon', 'wd', 'ark-memory', 'ark-ssd'];
  const defaultTargets: ScrapeTarget[] = ['tek', 'pside', 'amazon', 'wd'];

  if (args.length === 0) {
    return [...defaultTargets];
  }

  const invalid = args.filter((arg) => !valid.includes(arg as ScrapeTarget));
  if (invalid.length > 0) {
    console.error(`不正な引数: ${invalid.join(', ')}`);
    console.error(`有効な引数: ${valid.join(', ')}`);
    process.exit(1);
  }

  return args as ScrapeTarget[];
}

async function runWithTargetContext<T>(
  target: ScrapeTarget,
  headless: boolean,
  getBrowser: () => Promise<Browser>,
  handler: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await createContextForTarget(target, headless, getBrowser);

  try {
    return await handler(context);
  } finally {
    await context.close();
  }
}

function createArkMemoryConfig(headless: boolean): ArkMemoryConfig {
  const targetUrls = resolveArkUrls('ARK_MEMORY_URLS', 'ARK_MEMORY_URL');
  if (targetUrls.length === 0) {
    throw new Error('ARK_MEMORY_URLS または ARK_MEMORY_URL を設定してください');
  }

  return {
    prefix: 'ark-memory_',
    csvFileName: OUTPUT_FILE_NAME,
    targetUrls,
    artifactRootDir: resolveArkArtifactRootDir(),
    timeoutMs: resolveNumberEnv('ARK_TIMEOUT_MS', 60000),
    headed: !headless,
    storageStatePath: resolveArkStorageStatePath(),
    debug: resolveBooleanEnv('ARK_DEBUG', false),
    maxPages: resolveNumberEnv('ARK_MEMORY_MAX_PAGES', 0),
  };
}

function createArkSsdConfig(headless: boolean): ArkSsdConfig {
  const targetUrls = resolveArkUrls('ARK_SSD_URLS', 'ARK_SSD_URL');
  if (targetUrls.length === 0) {
    throw new Error('ARK_SSD_URLS または ARK_SSD_URL を設定してください');
  }

  return {
    prefix: 'ark-ssd_',
    csvFileName: OUTPUT_FILE_NAME,
    targetUrls,
    artifactRootDir: resolveArkArtifactRootDir(),
    timeoutMs: resolveNumberEnv('ARK_TIMEOUT_MS', 60000),
    headed: !headless,
    storageStatePath: resolveArkStorageStatePath(),
    debug: resolveBooleanEnv('ARK_DEBUG', false),
  };
}

function resolveArkUrls(listEnvName: string, singleEnvName: string): string[] {
  const urlsFromList = parseUrlList(process.env[listEnvName]);
  if (urlsFromList.length > 0) {
    return urlsFromList;
  }

  const singleUrl = process.env[singleEnvName]?.trim();
  return singleUrl ? [singleUrl] : [];
}

function resolveArkArtifactRootDir(): string {
  return path.resolve(process.env.ARK_ARTIFACT_DIR ?? './playwright-artifacts');
}

function resolveArkStorageStatePath(): string | undefined {
  const explicitPath = process.env.ARK_STORAGE_STATE_PATH;
  if (explicitPath !== undefined && explicitPath.trim() === '') {
    return undefined;
  }

  return path.resolve(explicitPath || path.join(resolveArkArtifactRootDir(), 'ark-storage.json'));
}

function resolveExistingArkStorageStatePath(): string | undefined {
  const storageStatePath = resolveArkStorageStatePath();
  if (!storageStatePath) {
    return undefined;
  }

  return fs.existsSync(storageStatePath) ? storageStatePath : undefined;
}

function resolveArkMemoryR2Key(): string {
  return process.env.ARK_MEMORY_R2_KEY || 'ark_csv/ark-memory-latest.csv';
}

function resolveArkSsdR2Key(): string {
  return process.env.ARK_SSD_R2_KEY || 'ark_csv/ark-ssd-latest.csv';
}

function resolveBooleanEnv(envName: string, fallback: boolean): boolean {
  const rawValue = process.env[envName];
  if (!rawValue) {
    return fallback;
  }

  return !['0', 'false', 'no', 'off'].includes(rawValue.toLowerCase());
}

function resolveNumberEnv(envName: string, fallback: number): number {
  const rawValue = process.env[envName];
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

function isArkTarget(target: ScrapeTarget): boolean {
  return target === 'ark-memory' || target === 'ark-ssd';
}

main();
