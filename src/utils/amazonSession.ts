import { BrowserContext, Page } from 'playwright';

const AMAZON_DEFAULT_HEADERS = {
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'Upgrade-Insecure-Requests': '1',
};

const AMAZON_PAGE_WAIT_MS = 3000;
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

export interface AmazonBlockState {
  blocked: boolean;
  title: string;
  bodyText: string;
}

export interface WarmUpAmazonSessionOptions {
  followUpUrl?: string;
}

export async function createAmazonPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.setExtraHTTPHeaders(AMAZON_DEFAULT_HEADERS);
  return page;
}

export async function applyAmazonStealth(context: BrowserContext): Promise<void> {
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

export async function warmUpAmazonSession(
  page: Page,
  options: WarmUpAmazonSessionOptions = {},
): Promise<void> {
  await page.setExtraHTTPHeaders(AMAZON_DEFAULT_HEADERS);
  await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await continueAmazonShoppingIfNeeded(page);
  await sleep(1500);
  await ensureAmazonDeliveryLocation(page);

  if (options.followUpUrl) {
    await page.goto(options.followUpUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => undefined);
    await sleep(1000);
  }
}

export async function continueAmazonShoppingIfNeeded(page: Page): Promise<boolean> {
  const bodyText = normalizeAmazonText((await page.textContent('body')) ?? '');
  if (!bodyText.includes('ショッピングを続けてください')) {
    return false;
  }

  const continueButton = page.getByText('ショッピングを続ける').first();
  if ((await continueButton.count()) === 0) {
    return false;
  }

  console.log('[Amazon] continue-shopping 中間画面を突破');
  await continueButton.click({ timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await sleep(2500);

  return true;
}

export async function ensureAmazonDeliveryLocation(page: Page): Promise<void> {
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

export async function readAmazonBlockState(page: Page, status: number | null = null): Promise<AmazonBlockState> {
  const title = await page.title().catch(() => '');
  const bodyText = normalizeAmazonText((await page.textContent('body').catch(() => '')) ?? '');

  return {
    blocked: isAmazonBlockedStatusOrText(status, title, bodyText),
    title,
    bodyText,
  };
}

export async function assertAmazonNotBlocked(page: Page, label: string): Promise<void> {
  const state = await readAmazonBlockState(page);
  if (state.blocked) {
    throw new Error(`[Amazon] ${label} はボット検知またはエラーページでした: ${state.title || '無題'}`);
  }
}

export function isAmazonBlockedStatusOrText(status: number | null, title: string, bodyText: string): boolean {
  if (status === 403 || status === 429) {
    return true;
  }

  const normalized = `${title} ${bodyText}`.toLowerCase();
  return AMAZON_BLOCK_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

export function normalizeAmazonText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function buildAmazonSearchUrl(query: string, pageNum = 1): string {
  const url = new URL('https://www.amazon.co.jp/s');
  url.searchParams.set('k', query);
  if (pageNum > 1) {
    url.searchParams.set('page', String(pageNum));
  }
  return url.toString();
}

export function getAmazonMaxPageOpenAttempts(): number {
  return AMAZON_MAX_PAGE_OPEN_ATTEMPTS;
}

export function getAmazonRetryDelayMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * AMAZON_RETRY_DELAY_JITTER_MS);
  return AMAZON_RETRY_DELAY_BASE_MS * attempt + jitter;
}

export function getAmazonPageWaitMs(): number {
  return AMAZON_PAGE_WAIT_MS + Math.floor(Math.random() * 1200);
}

async function closeAmazonDeliveryPopover(page: Page): Promise<void> {
  const closeButton = page.locator('#GLUXConfirmClose').first();
  if ((await closeButton.count()) > 0) {
    await closeButton.click({ timeout: 5000 }).catch(() => undefined);
    await sleep(1000);
  }
}

async function getAmazonDeliveryDestination(page: Page): Promise<string> {
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}