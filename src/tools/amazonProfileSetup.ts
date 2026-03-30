import 'dotenv/config';
import { chromium } from 'playwright';

const MARKETPLACE_ID = 'A1VC38T7YXB528';
const MERCHANT_ID = process.env.AMAZON_MERCHANT_ID ?? 'A290QSZB4BCGSX';
const DEFAULT_PROFILE_DIR = './.playwright/amazon-profile';

async function main(): Promise<void> {
  const userDataDir = process.env.AMAZON_PERSISTENT_USER_DATA_DIR ?? DEFAULT_PROFILE_DIR;
  const targetUrl = process.env.AMAZON_PROFILE_TARGET_URL ?? buildMerchantItemsUrl(MERCHANT_ID);
  const headless = process.env.HEADLESS === 'true';
  const autoCloseMs = Number(process.env.AMAZON_SETUP_AUTO_CLOSE_MS ?? '0');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1920, height: 1080 },
    colorScheme: 'light',
  });

  context.on('page', async (page) => {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
    }).catch(() => undefined);
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log(`[Amazon Setup] profile: ${userDataDir}`);
  console.log(`[Amazon Setup] target: ${targetUrl}`);
  console.log('[Amazon Setup] ログイン状態、配送先、一覧件数を確認してください。');
  console.log('[Amazon Setup] ブラウザを閉じるとプロファイルが保存されます。');

  if (Number.isFinite(autoCloseMs) && autoCloseMs > 0) {
    await page.waitForTimeout(autoCloseMs);
    await context.close();
    return;
  }

  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
  });
}

function buildMerchantItemsUrl(merchantId: string): string {
  const url = new URL('https://www.amazon.co.jp/s');
  url.searchParams.set('i', 'merchant-items');
  url.searchParams.set('me', merchantId);
  url.searchParams.set('marketplaceID', MARKETPLACE_ID);
  return url.toString();
}

main().catch((error) => {
  console.error('[Amazon Setup] エラー:', error);
  process.exit(1);
});