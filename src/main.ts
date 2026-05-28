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
 *   npx ts-node src/main.ts market-smoke # Market smoke のみ
 *   npx ts-node src/main.ts market-official-site # 公式サイト巡回のみ
 *   npx ts-node src/main.ts market-amazon-search # Amazon 検索のみ
 *   npx ts-node src/main.ts market-bic-search # BicCamera 検索のみ
 */

import 'dotenv/config';
import { chromium, Browser, BrowserContext } from 'playwright';
import { loadMarketResearchConfig, resolveMarketHeadless } from './config/marketResearchConfig';
import { scrapeArkMemory } from './scrapers/arkMemory';
import { scrapeArkSsd } from './scrapers/arkSsd';
import { scrapeMarketAmazonSearch } from './scrapers/marketAmazonSearch';
import { scrapeMarketBicSearch } from './scrapers/marketBicSearch';
import { scrapeMarketOfficialSite } from './scrapers/marketOfficialSite';
import { scrapeMarketSmoke } from './scrapers/marketSmoke';
import { scrapeRakuten } from './scrapers/rakuten';
import { scrapeAmazon } from './scrapers/amazon';
import { scrapeWD } from './scrapers/wd';
import { sendErrorEmail } from './utils/mailer';
import { DEFAULT_ARK_USER_AGENT, parseUrlList } from './utils/arkHelpers';
import {
  buildBicLaunchOptions,
  buildBicPersistentContextOptions,
  buildDefaultChromiumLaunchOptions,
  buildMarketContextOptions,
  resolveBicBrowserChannel,
  resolveBicDisableHttp2,
  resolveBicPersistentUserDataDir,
} from './utils/bicBrowser';
import { isSharePointUploadConfigured, uploadFilesToSharePointIfConfigured } from './utils/sharepoint';
import { uploadFilesToR2IfConfigured, R2UploadFile } from './utils/storageUpload';
import {
  RakutenConfig,
  AmazonConfig,
  WDConfig,
  ArkMemoryConfig,
  ArkSsdConfig,
  MarketResearchConfig,
} from './types';
import fs from 'fs';
import path from 'path';

type ExistingScrapeTarget = 'tek' | 'pside' | 'amazon' | 'wd' | 'ark-memory' | 'ark-ssd';
type MarketScrapeTarget = 'market-smoke' | 'market-official-site' | 'market-amazon-search' | 'market-bic-search';
type ScrapeTarget = ExistingScrapeTarget | MarketScrapeTarget;

interface CliOptions {
  targets: ScrapeTarget[];
  marketConfigPath?: string;
}

interface TargetRunOptions {
  marketConfig?: MarketResearchConfig;
}

// =====================================================
// 設定定数
// =====================================================

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';
const RESOLVED_OUTPUT_DIR = path.resolve(OUTPUT_DIR);
const RUN_TIMESTAMP = formatOutputTimestamp(new Date());
const OUTPUT_FILE_NAME = `${RUN_TIMESTAMP}.csv`;
const TARGET_MAX_ATTEMPTS = Math.max(1, resolveNumberEnv('SCRAPER_TARGET_MAX_ATTEMPTS', 2));
const TARGET_RETRY_DELAY_MS = Math.max(1000, resolveNumberEnv('SCRAPER_TARGET_RETRY_DELAY_MS', 5000));
const SHAREPOINT_STAGING_DIR = path.join(RESOLVED_OUTPUT_DIR, '.sharepoint-staging', RUN_TIMESTAMP);

interface SharePointStagedFile {
  sourcePath: string;
  stagedPath: string;
  target: Extract<ScrapeTarget, 'tek' | 'pside' | 'amazon' | 'wd'>;
}

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
  const { targets, marketConfigPath } = getCliOptions();
  const headless = process.env.HEADLESS !== 'false';
  const sharePointFiles: SharePointStagedFile[] = [];
  const r2Files: R2UploadFile[] = [];
  const ranOnlyArkTargets = targets.length > 0 && targets.every(isArkTarget);
  const marketConfigBundle = targets.some(isMarketTarget)
    ? await loadMarketResearchConfig(marketConfigPath)
    : undefined;

  try {
    for (const target of targets) {
      if (target === 'tek') {
        const outputFilePath = getOutputFilePath(TEK_CONFIG.prefix, OUTPUT_FILE_NAME);
        await runTargetWithRetries(target, headless, outputFilePath, async (context) => {
          await scrapeRakuten(context, { ...TEK_CONFIG, csvFileName: OUTPUT_FILE_NAME });
        });
        sharePointFiles.push(await stageSharePointFile(target, outputFilePath));
        continue;
      }

      if (target === 'pside') {
        const outputFilePath = getOutputFilePath(PSIDE_CONFIG.prefix, OUTPUT_FILE_NAME);
        await runTargetWithRetries(target, headless, outputFilePath, async (context) => {
          await scrapeRakuten(context, { ...PSIDE_CONFIG, csvFileName: OUTPUT_FILE_NAME });
        });
        sharePointFiles.push(await stageSharePointFile(target, outputFilePath));
        continue;
      }

      if (target === 'amazon') {
        const outputFilePath = getOutputFilePath(AMAZON_CONFIG.prefix, OUTPUT_FILE_NAME);
        await runTargetWithRetries(target, headless, outputFilePath, async (context) => {
          await scrapeAmazon(context, AMAZON_CONFIG);
        });
        sharePointFiles.push(await stageSharePointFile(target, outputFilePath));
        continue;
      }

      if (target === 'wd') {
        const outputFilePath = getOutputFilePath(WD_CONFIG.prefix, OUTPUT_FILE_NAME);
        await runTargetWithRetries(target, headless, outputFilePath, async (context) => {
          await scrapeWD(context, WD_CONFIG);
        });
        sharePointFiles.push(await stageSharePointFile(target, outputFilePath));
        continue;
      }

      if (target === 'market-smoke') {
        if (!marketConfigBundle) {
          throw new Error('market-smoke 実行には market config が必要です');
        }

        const marketHeadless = resolveMarketHeadless(marketConfigBundle.config, headless);
        console.log(`[Market] config 読み込み: ${marketConfigBundle.configPath}`);
        await runTargetOnce(
          target,
          marketHeadless,
          async (context) => {
            await scrapeMarketSmoke(context, marketConfigBundle.config, {
              headless: marketHeadless,
            });
          },
          { marketConfig: marketConfigBundle.config },
        );
        continue;
      }

      if (target === 'market-official-site') {
        if (!marketConfigBundle) {
          throw new Error('market-official-site 実行には market config が必要です');
        }

        const marketHeadless = resolveMarketHeadless(marketConfigBundle.config, headless);
        console.log(`[Market] config 読み込み: ${marketConfigBundle.configPath}`);
        await runTargetOnce(
          target,
          marketHeadless,
          async (context) => {
            await scrapeMarketOfficialSite(context, marketConfigBundle.config, {
              headless: marketHeadless,
            });
          },
          { marketConfig: marketConfigBundle.config },
        );
        continue;
      }

      if (target === 'market-amazon-search') {
        if (!marketConfigBundle) {
          throw new Error('market-amazon-search 実行には market config が必要です');
        }

        const marketHeadless = resolveMarketHeadless(marketConfigBundle.config, headless);
        console.log(`[Market] config 読み込み: ${marketConfigBundle.configPath}`);
        await runTargetOnce(
          target,
          marketHeadless,
          async (context) => {
            await scrapeMarketAmazonSearch(context, marketConfigBundle.config, {
              headless: marketHeadless,
            });
          },
          { marketConfig: marketConfigBundle.config },
        );
        continue;
      }

      if (target === 'market-bic-search') {
        if (!marketConfigBundle) {
          throw new Error('market-bic-search 実行には market config が必要です');
        }

        const marketHeadless = resolveMarketHeadless(marketConfigBundle.config, headless);
        console.log(`[Market] config 読み込み: ${marketConfigBundle.configPath}`);
        await runTargetOnce(
          target,
          marketHeadless,
          async (context) => {
            await scrapeMarketBicSearch(context, marketConfigBundle.config, {
              headless: marketHeadless,
            });
          },
          { marketConfig: marketConfigBundle.config },
        );
        continue;
      }

      if (target === 'ark-memory') {
        const config = createArkMemoryConfig(headless);
        await runTargetOnce(target, headless, async (context) => {
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
        await runTargetOnce(target, headless, async (context) => {
          await scrapeArkSsd(context, config);
        });
        r2Files.push({
          filePath: getOutputFilePath(config.prefix, config.csvFileName),
          key: resolveArkSsdR2Key(),
        });
      }
    }

    const sharePointConfigured = isSharePointUploadConfigured();
    const uploadedSharePointFiles = await uploadFilesToSharePointIfConfigured(
      sharePointFiles.map((file) => file.stagedPath),
    );
    if (sharePointConfigured) {
      await removeUploadedFiles(
        sharePointFiles
          .filter((file) => uploadedSharePointFiles.includes(file.stagedPath))
          .flatMap((file) => [file.stagedPath, file.sourcePath]),
      );
    }

    const r2UploadCompleted = await uploadFilesToR2IfConfigured(r2Files);
    if (ranOnlyArkTargets && r2UploadCompleted) {
        await removeArkUploadedFiles(r2Files.map((file) => file.filePath));
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
  }
}

function getOutputFilePath(prefix: string, fileName: string): string {
  return path.resolve(OUTPUT_DIR, `${prefix}${fileName}`);
}

async function removeUploadedFiles(filePaths: string[]): Promise<void> {
  await removeOutputFiles(filePaths, '[Output] SharePointアップロード済みファイルを削除');
}

async function removeArkUploadedFiles(filePaths: string[]): Promise<void> {
  await removeOutputFiles(filePaths, '[Output] Arkアップロード済みCSVを削除');
}

async function removeOutputFiles(filePaths: string[], logMessage: string): Promise<void> {
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

  console.log(`${logMessage}: ${existingFiles.length}件`);
}

async function runTargetOnce<T>(
  target: ScrapeTarget,
  headless: boolean,
  handler: (context: BrowserContext) => Promise<T>,
  options: TargetRunOptions = {},
): Promise<T> {
  let browser: Browser | null = null;
  const launchOptions = resolveLaunchOptionsForTarget(target, headless);

  const getBrowser = async (): Promise<Browser> => {
    if (!browser) {
      browser = await chromium.launch(launchOptions);
    }

    return browser;
  };

  try {
    return await runWithTargetContext(target, headless, getBrowser, handler, options);
  } finally {
    const currentBrowser = browser as Browser | null;
    if (currentBrowser !== null) {
      await currentBrowser.close().catch(() => undefined);
    }
  }
}

async function runTargetWithRetries<T>(
  target: Extract<ScrapeTarget, 'tek' | 'pside' | 'amazon' | 'wd'>,
  headless: boolean,
  outputFilePath: string,
  handler: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TARGET_MAX_ATTEMPTS; attempt++) {
    await removeFileIfExists(outputFilePath);

    try {
      const result = await runTargetOnce(target, headless, handler);
      await assertOutputFileReady(target, outputFilePath);
      return result;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableTargetError(error);
      const hasRemainingAttempts = attempt < TARGET_MAX_ATTEMPTS;

      console.warn(`[scheduler] ${target} 実行失敗 (${attempt}/${TARGET_MAX_ATTEMPTS}): ${formatErrorMessage(error)}`);

      if (!retryable || !hasRemainingAttempts) {
        break;
      }

      await sleep(TARGET_RETRY_DELAY_MS * attempt);
      console.warn(`[scheduler] ${target} を再試行します (${attempt + 1}/${TARGET_MAX_ATTEMPTS})`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function assertOutputFileReady(
  target: Extract<ScrapeTarget, 'tek' | 'pside' | 'amazon' | 'wd'>,
  outputFilePath: string,
): Promise<void> {
  const stats = await fs.promises.stat(outputFilePath).catch(() => null);
  if (!stats?.isFile() || stats.size <= 0) {
    throw new Error(`[${target}] 出力CSVが確認できませんでした: ${outputFilePath}`);
  }

  console.log(`[Output] ${target} CSV確認: ${outputFilePath} (${stats.size} bytes)`);
}

async function stageSharePointFile(
  target: Extract<ScrapeTarget, 'tek' | 'pside' | 'amazon' | 'wd'>,
  sourcePath: string,
): Promise<SharePointStagedFile> {
  const stagedPath = path.join(SHAREPOINT_STAGING_DIR, path.basename(sourcePath));
  await fs.promises.mkdir(SHAREPOINT_STAGING_DIR, { recursive: true });
  await fs.promises.copyFile(sourcePath, stagedPath);

  console.log(`[Output] SharePointステージング完了 (${target}): ${stagedPath}`);

  return {
    target,
    sourcePath,
    stagedPath,
  };
}

async function removeFileIfExists(filePath: string): Promise<void> {
  await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
}

function isRetryableTargetError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();

  return [
    'target page, context or browser has been closed',
    'browser has been closed',
    'page has been closed',
    'navigation failed because page was closed',
    'execution context was destroyed',
    'timeout',
    '出力csvが確認できませんでした',
  ].some((keyword) => message.includes(keyword));
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  options: TargetRunOptions = {},
): Promise<BrowserContext> {
  if (target === 'market-bic-search') {
    logBicRuntimeSettings();
    const userDataDir = resolveBicPersistentUserDataDir();
    const marketConfig = options.marketConfig;

    if (userDataDir) {
      if (!marketConfig) {
        throw new Error(`${target} 実行には market config が必要です`);
      }

      console.log(`[Bic] 永続プロファイルを使用: ${userDataDir}`);
      return chromium.launchPersistentContext(
        userDataDir,
        buildBicPersistentContextOptions(headless, marketConfig),
      );
    }
  }

  if (usesAmazonPersistentProfile(target)) {
    const userDataDir = process.env.AMAZON_PERSISTENT_USER_DATA_DIR;
    if (userDataDir) {
      console.log(`[Amazon] 永続プロファイルを使用: ${userDataDir}`);
      const locale = options.marketConfig?.locale ?? 'ja-JP';
      const timezoneId = options.marketConfig?.timezone ?? 'Asia/Tokyo';
      const viewport = options.marketConfig?.viewport ?? { width: 1920, height: 1080 };
      return chromium.launchPersistentContext(userDataDir, {
        ...buildDefaultChromiumLaunchOptions(headless),
        locale,
        timezoneId,
        viewport,
        colorScheme: 'light',
      });
    }
  }

  if (isMarketTarget(target)) {
    const marketConfig = options.marketConfig;
    if (!marketConfig) {
      throw new Error(`${target} 実行には market config が必要です`);
    }

    const browser = await getBrowser();
    return browser.newContext(buildMarketContextOptions(marketConfig));
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
 * コマンドライン引数からターゲットとオプションを取得する
 * 引数なし → 既存スクレイパーのみ実行 (tek → pside → amazon → wd)
 */
function getCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  const targets: ScrapeTarget[] = [];
  const valid: ScrapeTarget[] = ['tek', 'pside', 'amazon', 'wd', 'ark-memory', 'ark-ssd', 'market-smoke', 'market-official-site', 'market-amazon-search', 'market-bic-search'];
  const defaultTargets: ScrapeTarget[] = ['tek', 'pside', 'amazon', 'wd'];
  let marketConfigPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--config') {
      const nextValue = args[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        console.error('--config には設定ファイルパスが必要です');
        process.exit(1);
      }

      marketConfigPath = nextValue;
      index += 1;
      continue;
    }

    if (arg.startsWith('--config=')) {
      marketConfigPath = arg.slice('--config='.length);
      continue;
    }

    if (arg.startsWith('--')) {
      console.error(`不正なオプション: ${arg}`);
      process.exit(1);
    }

    targets.push(arg as ScrapeTarget);
  }

  if (targets.length === 0) {
    return {
      targets: [...defaultTargets],
      marketConfigPath,
    };
  }

  const invalid = targets.filter((target) => !valid.includes(target));
  if (invalid.length > 0) {
    console.error(`不正な引数: ${invalid.join(', ')}`);
    console.error(`有効な引数: ${valid.join(', ')}`);
    process.exit(1);
  }

  return {
    targets,
    marketConfigPath,
  };
}

async function runWithTargetContext<T>(
  target: ScrapeTarget,
  headless: boolean,
  getBrowser: () => Promise<Browser>,
  handler: (context: BrowserContext) => Promise<T>,
  options: TargetRunOptions = {},
): Promise<T> {
  const context = await createContextForTarget(target, headless, getBrowser, options);

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

function isMarketTarget(target: ScrapeTarget): target is MarketScrapeTarget {
  return target === 'market-smoke'
    || target === 'market-official-site'
    || target === 'market-amazon-search'
    || target === 'market-bic-search';
}

function usesAmazonPersistentProfile(target: ScrapeTarget): boolean {
  return target === 'amazon' || target === 'market-amazon-search';
}

function resolveLaunchOptionsForTarget(target: ScrapeTarget, headless: boolean) {
  if (target === 'market-bic-search') {
    return buildBicLaunchOptions(headless);
  }

  return buildDefaultChromiumLaunchOptions(headless);
}

function logBicRuntimeSettings(): void {
  const channel = resolveBicBrowserChannel();
  const disableHttp2 = resolveBicDisableHttp2();

  if (channel) {
    console.log(`[Bic] browser channel: ${channel}`);
  }

  if (disableHttp2) {
    console.log('[Bic] launch arg: --disable-http2');
  }
}

main();
