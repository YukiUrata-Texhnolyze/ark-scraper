import 'dotenv/config';
import { chromium, Page } from 'playwright';
import {
  BIC_HOME_URL,
  buildBicPersistentContextOptions,
  DEFAULT_BIC_PROFILE_DIR,
  resolveBicBrowserChannel,
  resolveBicDisableHttp2,
} from '../utils/bicBrowser';

async function main(): Promise<void> {
  const userDataDir = process.env.BIC_PERSISTENT_USER_DATA_DIR ?? DEFAULT_BIC_PROFILE_DIR;
  const targetUrl = process.env.BIC_PROFILE_TARGET_URL ?? BIC_HOME_URL;
  const headless = process.env.HEADLESS === 'true';
  const autoCloseMs = Number(process.env.BIC_SETUP_AUTO_CLOSE_MS ?? '0');
  const channel = resolveBicBrowserChannel();
  const disableHttp2 = resolveBicDisableHttp2();

  const context = await chromium.launchPersistentContext(
    userDataDir,
    buildBicPersistentContextOptions(headless),
  );

  context.on('page', async (page) => {
    await primeBicPage(page);
  });

  const page = context.pages()[0] ?? await context.newPage();
  await primeBicPage(page);
  await page.goto(BIC_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500).catch(() => undefined);

  if (targetUrl !== BIC_HOME_URL) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
  }

  console.log(`[Bic Setup] profile: ${userDataDir}`);
  console.log(`[Bic Setup] target: ${targetUrl}`);
  console.log(`[Bic Setup] headless: ${headless}`);
  if (channel) {
    console.log(`[Bic Setup] channel: ${channel}`);
  }
  if (disableHttp2) {
    console.log('[Bic Setup] launch arg: --disable-http2');
  }
  console.log('[Bic Setup] Cookie 同意、確認画面、CAPTCHA があればブラウザ上で人手対応してください。');
  console.log('[Bic Setup] ブラウザを閉じるとプロファイルが保存されます。');

  if (Number.isFinite(autoCloseMs) && autoCloseMs > 0) {
    await page.waitForTimeout(autoCloseMs);
    await context.close();
    return;
  }

  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
  });
}

async function primeBicPage(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
  }).catch(() => undefined);
}

main().catch((error) => {
  console.error('[Bic Setup] エラー:', error);
  process.exit(1);
});