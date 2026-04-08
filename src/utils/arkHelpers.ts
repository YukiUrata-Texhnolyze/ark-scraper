import fs from 'fs';
import path from 'path';
import { Page } from 'playwright';
import { ArkMemoryItem, ArkSsdItem } from '../types';

export const DEFAULT_ARK_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface ParsedPrice {
  priceYen: number | null;
  priceRaw: string | null;
}

interface ParsedSalePeriod {
  salePeriodRaw: string | null;
  saleStart: string | null;
  saleEnd: string | null;
}

interface ParsedStockState {
  inStock: boolean | null;
  inStockLabel: string | null;
  stockStatus: string | null;
}

interface ParsedMemorySpecs {
  memoryDdr: string | null;
  memoryCapacityGb: number | null;
  memorySpeed: number | null;
  sticks: number | null;
  memoryCapacityPerStickGb: number | null;
}

interface ParsedSsdSpecs {
  capacityGb: number | null;
  capacityText: string | null;
  interfaceText: string | null;
  formFactor: string | null;
  tagsText: string | null;
}

export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function ensureDirForFile(filePath: string): Promise<void> {
  await ensureDirectory(path.dirname(path.resolve(filePath)));
}

export function buildArkRunLabel(prefix: string, csvFileName: string): string {
  const extension = path.extname(csvFileName);
  const baseName = extension ? csvFileName.slice(0, -extension.length) : csvFileName;
  return `${prefix}${baseName}`;
}

export function parseUrlList(text: string | undefined): string[] {
  if (!text) {
    return [];
  }

  return String(text)
    .split(/\s*,\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function compactSpaces(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function capturePageArtifacts(
  page: Page,
  htmlPath: string,
  screenshotPath: string,
): Promise<void> {
  await ensureDirForFile(htmlPath);
  await ensureDirForFile(screenshotPath);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    console.warn(`[ARK] スクリーンショット保存失敗: ${screenshotPath}`, error);
  }

  try {
    const html = await page.content();
    await fs.promises.writeFile(htmlPath, html, 'utf8');
  } catch (error) {
    console.warn(`[ARK] HTML保存失敗: ${htmlPath}`, error);
  }
}

export async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await ensureDirForFile(resolvedPath);
  await fs.promises.writeFile(resolvedPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[ARK] JSON 保存完了: ${resolvedPath}`);
}

export async function writeCsvRows(filePath: string, rows: Array<Array<unknown>>): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await ensureDirForFile(resolvedPath);

  const body = rows
    .map((row) => row.map((cell) => csvEscape(cell)).join(','))
    .join('\n');

  await fs.promises.writeFile(resolvedPath, `\uFEFF${body}${rows.length > 0 ? '\n' : ''}`, 'utf8');
  console.log(`[CSV] 保存完了: ${resolvedPath}`);
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const normalized = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  return normalized;
}

export function parsePriceYen(text: string): ParsedPrice {
  const normalizedText = compactSpaces(text);
  const match = normalizedText.match(/(?:¥|￥)\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円/);
  const raw = match?.[1] || match?.[2];

  if (!raw) {
    return { priceYen: null, priceRaw: null };
  }

  const numericValue = Number(String(raw).replace(/,/g, ''));
  return {
    priceYen: Number.isFinite(numericValue) ? numericValue : null,
    priceRaw: raw,
  };
}

export function parseCouponDiscountYen(text: string): number | null {
  const normalizedText = compactSpaces(text);
  const match = normalizedText.match(/([0-9][0-9,]*)\s*円\s*(?:引き|OFF|オフ)/i)
    || normalizedText.match(/(?:¥|￥)\s*([0-9][0-9,]*)\s*(?:OFF|オフ)/i);
  const raw = match?.[1];

  if (!raw) {
    return null;
  }

  const numericValue = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function removeCouponText(text: string, couponText: string | undefined): string {
  let normalizedText = String(text || '');
  if (couponText) {
    normalizedText = normalizedText.replace(couponText, ' ');
  }

  normalizedText = normalizedText.replace(/([0-9][0-9,]*)\s*円\s*(?:引き|OFF|オフ)/gi, ' ');
  normalizedText = normalizedText.replace(/(?:¥|￥)\s*([0-9][0-9,]*)\s*(?:OFF|オフ)/gi, ' ');
  return normalizedText;
}

export function parseProductNumber(text: string, url: string | null): string | null {
  const normalizedText = compactSpaces(text);
  const patterns = [
    /商品番号\s*[:：]\s*([^\s]+)/,
    /商品コード\s*[:：]\s*([^\s]+)/,
    /型番\s*[:：]\s*([^\s]+)/,
    /品番\s*[:：]\s*([^\s]+)/,
    /SKU\s*[:：]\s*([^\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1] || '';
    return lastPart.length >= 4 ? lastPart : null;
  } catch {
    return null;
  }
}

export function parseSalePeriod(text: string): ParsedSalePeriod {
  const salePeriodRaw = compactSpaces(text);
  if (!salePeriodRaw) {
    return {
      salePeriodRaw: null,
      saleStart: null,
      saleEnd: null,
    };
  }

  const rangeMatch = salePeriodRaw.match(
    /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(?:[~〜\-]|から)\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/,
  );
  if (rangeMatch) {
    return {
      salePeriodRaw,
      saleStart: buildCurrentYearJstIso(rangeMatch[1], rangeMatch[2], rangeMatch[3], rangeMatch[4]),
      saleEnd: buildCurrentYearJstIso(rangeMatch[5], rangeMatch[6], rangeMatch[7], rangeMatch[8]),
    };
  }

  const untilMatch = salePeriodRaw.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*まで/);
  return {
    salePeriodRaw,
    saleStart: null,
    saleEnd: untilMatch
      ? buildCurrentYearJstIso(untilMatch[1], untilMatch[2], untilMatch[3], untilMatch[4])
      : null,
  };
}

export function parseSaleEndGuessJst(text: string): string | null {
  const normalizedText = compactSpaces(text);
  const match = normalizedText.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*まで/);
  if (!match) {
    return null;
  }

  return buildCurrentYearJstIso(match[1], match[2], match[3], match[4]);
}

function buildCurrentYearJstIso(month: string, day: string, hour: string, minute: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const pad2 = (value: string) => String(value).padStart(2, '0');
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00+09:00`;
}

export function normalizeStockLabel(text: string): ParsedStockState {
  const normalizedText = compactSpaces(text);
  if (!normalizedText) {
    return {
      inStock: null,
      inStockLabel: null,
      stockStatus: null,
    };
  }

  if (/(在庫あり|即納|販売中|翌日出荷|当日出荷)/.test(normalizedText)) {
    return {
      inStock: true,
      inStockLabel: normalizedText,
      stockStatus: 'in-stock',
    };
  }

  if (/(在庫切れ|売り切れ|入荷待ち|お取り寄せ|予約|販売終了|終息)/.test(normalizedText)) {
    return {
      inStock: false,
      inStockLabel: normalizedText,
      stockStatus: 'out-of-stock',
    };
  }

  return {
    inStock: null,
    inStockLabel: normalizedText,
    stockStatus: null,
  };
}

export function detectCloudflareBlock(title: string, bodyText: string): boolean {
  const normalizedTitle = String(title || '');
  const normalizedBodyText = String(bodyText || '');

  if (normalizedTitle.includes('Just a moment')) {
    return true;
  }
  if (normalizedBodyText.includes('Verifying you are human')) {
    return true;
  }
  if (normalizedBodyText.includes('needs to review the security')) {
    return true;
  }
  if (normalizedBodyText.includes('Sorry, you have been blocked')) {
    return true;
  }

  return false;
}

export async function waitForArkChallengeResolution(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const pageTitle = document.title || '';
      const bodyText = document.body?.textContent || '';
      const itemBoxes = document.querySelectorAll('.item_listbox').length;
      const productLinks = document.querySelectorAll('a[href*="/i/"], a[href*="/goods/"]').length;
      return !pageTitle.includes('Just a moment')
        && !bodyText.includes('Verifying you are human')
        && itemBoxes > 0
        && productLinks > 0;
    },
    undefined,
    { timeout: timeoutMs },
  );
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string | null | undefined): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(item);
  }

  return output;
}

export function pickMemoryTypeLabelFromTags(tags: string[]): string | null {
  const normalizedTags = tags.map((tag) => compactSpaces(tag)).filter(Boolean);
  const ddrTag = normalizedTags.find((tag) => /\bDDR\s*[34-6]\b/i.test(tag) || /\bDDR[34-6]\b/i.test(tag));
  return ddrTag || normalizedTags[0] || null;
}

export function normalizeMemoryTypeLabel(params: {
  baseLabel: string | null;
  specText: string | null;
  memDdr: string | null;
}): string | null {
  const baseLabel = compactSpaces(params.baseLabel);
  if (baseLabel) {
    return baseLabel;
  }

  const specText = compactSpaces(params.specText);
  if (specText) {
    const ddrMatch = specText.match(/(DDR\s*[34-6](?:[-\s]?\d{3,5})?)/i);
    if (ddrMatch?.[1]) {
      return compactSpaces(ddrMatch[1].toUpperCase().replace(/\s+/g, ' '));
    }
  }

  return params.memDdr ? compactSpaces(params.memDdr) : null;
}

export function parseMemorySpecsFromText(text: string): ParsedMemorySpecs {
  const normalizedText = compactSpaces(text);
  let memoryDdr: string | null = null;
  let memorySpeed: number | null = null;
  let sticks: number | null = null;
  let memoryCapacityGb: number | null = null;
  let memoryCapacityPerStickGb: number | null = null;

  const ddrMatch = normalizedText.match(/\bLP?DDR\s*([34-6])\b/i) || normalizedText.match(/\bDDR([34-6])\b/i);
  if (ddrMatch?.[1]) {
    memoryDdr = `DDR${ddrMatch[1]}`;
  }

  const speedMatch = normalizedText.match(/\bDDR[34-6][-\s]?(\d{3,5})\b/i)
    || normalizedText.match(/\b(\d{3,5})\s*(?:MT\/S|MHZ)\b/i);
  if (speedMatch?.[1]) {
    const speed = Number(speedMatch[1]);
    if (Number.isFinite(speed)) {
      memorySpeed = speed;
    }
  }

  const groupedCapacityMatch = normalizedText.match(
    /(\d+(?:\.\d+)?)\s*GB\s*\(\s*(\d+(?:\.\d+)?)\s*GB\s*[x×]\s*(\d{1,2})\s*\)/i,
  );
  if (groupedCapacityMatch) {
    memoryCapacityGb = Number(groupedCapacityMatch[1]);
    memoryCapacityPerStickGb = Number(groupedCapacityMatch[2]);
    sticks = Number(groupedCapacityMatch[3]);
  }

  const perStickMatch = normalizedText.match(/(\d+(?:\.\d+)?)\s*GB\s*[x×]\s*(\d{1,2})/i);
  if (perStickMatch) {
    const parsedPerStick = Number(perStickMatch[1]);
    const parsedSticks = Number(perStickMatch[2]);
    if (Number.isFinite(parsedPerStick)) {
      memoryCapacityPerStickGb = memoryCapacityPerStickGb ?? parsedPerStick;
    }
    if (Number.isFinite(parsedSticks)) {
      sticks = sticks ?? parsedSticks;
    }
    if (memoryCapacityGb == null && Number.isFinite(parsedPerStick) && Number.isFinite(parsedSticks)) {
      memoryCapacityGb = parsedPerStick * parsedSticks;
    }
  }

  const moduleMatch = normalizedText.match(/(\d+(?:\.\d+)?)\s*GB\s*モジュール/i);
  if (moduleMatch?.[1] && memoryCapacityPerStickGb == null) {
    const parsedPerStick = Number(moduleMatch[1]);
    if (Number.isFinite(parsedPerStick)) {
      memoryCapacityPerStickGb = parsedPerStick;
    }
  }

  const sticksMatch = normalizedText.match(/(\d{1,2})\s*(?:枚組|枚|kit|セット)/i);
  if (sticksMatch?.[1] && sticks == null) {
    const parsedSticks = Number(sticksMatch[1]);
    if (Number.isFinite(parsedSticks)) {
      sticks = parsedSticks;
    }
  }

  const totalCapacityMatch = normalizedText.match(/(\d{1,4}(?:\.\d+)?)\s*GB\b/i);
  if (totalCapacityMatch?.[1] && memoryCapacityGb == null) {
    const parsedTotalCapacity = Number(totalCapacityMatch[1]);
    if (Number.isFinite(parsedTotalCapacity)) {
      memoryCapacityGb = parsedTotalCapacity;
    }
  }

  if (memoryCapacityGb == null && memoryCapacityPerStickGb != null && sticks != null) {
    memoryCapacityGb = memoryCapacityPerStickGb * sticks;
  }

  if (memoryCapacityPerStickGb == null && memoryCapacityGb != null && sticks != null && sticks > 0) {
    memoryCapacityPerStickGb = memoryCapacityGb / sticks;
  }

  return {
    memoryDdr,
    memoryCapacityGb: Number.isFinite(memoryCapacityGb) ? memoryCapacityGb : null,
    memorySpeed: Number.isFinite(memorySpeed) ? memorySpeed : null,
    sticks: Number.isFinite(sticks) ? sticks : null,
    memoryCapacityPerStickGb: Number.isFinite(memoryCapacityPerStickGb) ? memoryCapacityPerStickGb : null,
  };
}

export function parseMemorySpecsFromTags(tags: string[], fallbackText: string): ParsedMemorySpecs {
  const normalizedTags = tags.map((tag) => compactSpaces(tag)).filter(Boolean);
  let memoryDdr: string | null = null;
  let memorySpeed: number | null = null;
  let memoryCapacityGb: number | null = null;
  let memoryCapacityPerStickGb: number | null = null;
  let sticks: number | null = null;

  for (const tag of normalizedTags) {
    const ddrMatch = tag.match(/\bDDR\s*([34-6])\b/i) || tag.match(/\bDDR([34-6])\b/i);
    if (!memoryDdr && ddrMatch?.[1]) {
      memoryDdr = `DDR${ddrMatch[1]}`;
    }

    const speedMatch = tag.match(/\bDDR[34-6][-\s]?(\d{3,5})\b/i) || tag.match(/\b(\d{3,5})\s*(?:MT\/S|MHZ)\b/i);
    if (memorySpeed == null && speedMatch?.[1]) {
      const parsedSpeed = Number(speedMatch[1]);
      if (Number.isFinite(parsedSpeed)) {
        memorySpeed = parsedSpeed;
      }
    }

    const groupedCapacityMatch = tag.match(/(\d+(?:\.\d+)?)\s*GB\s*\(\s*(\d+(?:\.\d+)?)\s*GB\s*[x×]\s*(\d{1,2})\s*\)/i);
    if (groupedCapacityMatch) {
      const parsedTotalCapacity = Number(groupedCapacityMatch[1]);
      const parsedPerStick = Number(groupedCapacityMatch[2]);
      const parsedSticks = Number(groupedCapacityMatch[3]);
      if (Number.isFinite(parsedTotalCapacity)) {
        memoryCapacityGb = parsedTotalCapacity;
      }
      if (Number.isFinite(parsedPerStick)) {
        memoryCapacityPerStickGb = parsedPerStick;
      }
      if (Number.isFinite(parsedSticks)) {
        sticks = parsedSticks;
      }
    }

    const exactCapacityMatch = tag.match(/^(\d+(?:\.\d+)?)\s*GB$/i);
    if (exactCapacityMatch?.[1] && memoryCapacityGb == null) {
      const parsedTotalCapacity = Number(exactCapacityMatch[1]);
      if (Number.isFinite(parsedTotalCapacity)) {
        memoryCapacityGb = parsedTotalCapacity;
      }
    }

    const moduleMatch = tag.match(/(\d+(?:\.\d+)?)\s*GB\s*モジュール/i);
    if (moduleMatch?.[1] && memoryCapacityPerStickGb == null) {
      const parsedPerStick = Number(moduleMatch[1]);
      if (Number.isFinite(parsedPerStick)) {
        memoryCapacityPerStickGb = parsedPerStick;
      }
    }

    const sticksMatch = tag.match(/(\d{1,2})\s*(?:枚組|枚|kit|セット)/i);
    if (sticksMatch?.[1] && sticks == null) {
      const parsedSticks = Number(sticksMatch[1]);
      if (Number.isFinite(parsedSticks)) {
        sticks = parsedSticks;
      }
    }
  }

  const fallbackSpecs = parseMemorySpecsFromText(fallbackText);
  memoryDdr = memoryDdr ?? fallbackSpecs.memoryDdr;
  memorySpeed = memorySpeed ?? fallbackSpecs.memorySpeed;
  sticks = sticks ?? fallbackSpecs.sticks;
  memoryCapacityGb = memoryCapacityGb ?? fallbackSpecs.memoryCapacityGb;
  memoryCapacityPerStickGb = memoryCapacityPerStickGb ?? fallbackSpecs.memoryCapacityPerStickGb;

  if (memoryCapacityPerStickGb == null && memoryCapacityGb != null && sticks != null && sticks > 0) {
    memoryCapacityPerStickGb = memoryCapacityGb / sticks;
  }

  if (memoryCapacityGb == null && memoryCapacityPerStickGb != null && sticks != null) {
    memoryCapacityGb = memoryCapacityPerStickGb * sticks;
  }

  return {
    memoryDdr,
    memoryCapacityGb: Number.isFinite(memoryCapacityGb) ? memoryCapacityGb : null,
    memorySpeed: Number.isFinite(memorySpeed) ? memorySpeed : null,
    sticks: Number.isFinite(sticks) ? sticks : null,
    memoryCapacityPerStickGb: Number.isFinite(memoryCapacityPerStickGb) ? memoryCapacityPerStickGb : null,
  };
}

export function sortArkMemoryItems(items: ArkMemoryItem[]): ArkMemoryItem[] {
  const ddrRank = (memoryDdr: string | null): number => {
    const normalizedValue = String(memoryDdr || '').toUpperCase();
    if (normalizedValue === 'DDR4') {
      return 0;
    }
    if (normalizedValue === 'DDR5') {
      return 1;
    }
    return 9;
  };

  const priceRank = (value: number | null): number => (
    typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  );

  return [...items].sort((left, right) => {
    const ddrDifference = ddrRank(left.memoryDdr) - ddrRank(right.memoryDdr);
    if (ddrDifference !== 0) {
      return ddrDifference;
    }

    const priceDifference = priceRank(left.finalPriceYen) - priceRank(right.finalPriceYen);
    if (priceDifference !== 0) {
      return priceDifference;
    }

    return String(left.productNumber || '').localeCompare(String(right.productNumber || ''));
  });
}

export function parseSsdSpecsFromTags(tags: string[], fallbackText: string): ParsedSsdSpecs {
  const normalizedTags = tags.map((tag) => compactSpaces(tag)).filter(Boolean);
  let capacityText: string | null = null;
  let capacityGb: number | null = null;
  let interfaceText: string | null = null;
  let formFactor: string | null = null;

  const pickFirst = (predicate: (tag: string) => boolean): string | null => {
    for (const tag of normalizedTags) {
      if (predicate(tag)) {
        return tag;
      }
    }
    return null;
  };

  const toGb = (value: string, unit: string): number | null => {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
      return null;
    }

    const normalizedUnit = String(unit || '').toUpperCase();
    if (normalizedUnit === 'TB') {
      return Math.round(parsedValue * 1000);
    }
    if (normalizedUnit === 'GB') {
      return Math.round(parsedValue);
    }
    return null;
  };

  const exactCapacity = pickFirst((tag) => /^\d+(?:\.\d+)?\s*(?:TB|GB)$/i.test(tag));
  if (exactCapacity) {
    capacityText = exactCapacity;
    const match = exactCapacity.match(/^(\d+(?:\.\d+)?)\s*(TB|GB)$/i);
    if (match) {
      capacityGb = toGb(match[1], match[2]);
    }
  }

  let lowerGb: number | null = null;
  let upperGb: number | null = null;
  let upperText: string | null = null;

  for (const tag of normalizedTags) {
    const rangeMatch = tag.match(/(\d+(?:\.\d+)?)\s*(TB|GB)\s*以上[〜~～\-]\s*(\d+(?:\.\d+)?)\s*(TB|GB)/i);
    if (rangeMatch) {
      const parsedLowerGb = toGb(rangeMatch[1], rangeMatch[2]);
      const parsedUpperGb = toGb(rangeMatch[3], rangeMatch[4]);
      if (parsedLowerGb != null) {
        lowerGb = lowerGb == null ? parsedLowerGb : Math.max(lowerGb, parsedLowerGb);
      }
      if (parsedUpperGb != null) {
        upperGb = upperGb == null ? parsedUpperGb : Math.max(upperGb, parsedUpperGb);
        upperText = `${rangeMatch[3]}${String(rangeMatch[4]).toUpperCase()}`;
      }
      continue;
    }

    const lowerMatch = tag.match(/(\d+(?:\.\d+)?)\s*(TB|GB)\s*以上/i);
    if (lowerMatch?.[1] && lowerMatch?.[2]) {
      const parsedLowerGb = toGb(lowerMatch[1], lowerMatch[2]);
      if (parsedLowerGb != null) {
        lowerGb = lowerGb == null ? parsedLowerGb : Math.max(lowerGb, parsedLowerGb);
      }
    }

    const upperMatch = tag.match(/^[〜~～]\s*(\d+(?:\.\d+)?)\s*(TB|GB)$/i)
      || tag.match(/[〜~～\-]\s*(\d+(?:\.\d+)?)\s*(TB|GB)$/i);
    if (upperMatch?.[1] && upperMatch?.[2]) {
      const parsedUpperGb = toGb(upperMatch[1], upperMatch[2]);
      if (parsedUpperGb != null) {
        upperGb = upperGb == null ? parsedUpperGb : Math.max(upperGb, parsedUpperGb);
        upperText = `${upperMatch[1]}${String(upperMatch[2]).toUpperCase()}`;
      }
    }
  }

  if (upperGb != null && (lowerGb == null || upperGb > lowerGb)) {
    capacityGb = upperGb;
    capacityText = upperText || capacityText;
  } else if (capacityGb == null && lowerGb != null) {
    capacityGb = lowerGb;
  }

  formFactor = pickFirst((tag) => /M\.2/i.test(tag))
    || pickFirst((tag) => /\b2280\b/.test(tag))
    || pickFirst((tag) => /\b2242\b/.test(tag))
    || pickFirst((tag) => /\b2230\b/.test(tag))
    || pickFirst((tag) => /2\.5/.test(tag))
    || null;

  interfaceText = pickFirst((tag) => /NVMe/i.test(tag))
    || pickFirst((tag) => /SATA/i.test(tag))
    || pickFirst((tag) => /PCIe/i.test(tag))
    || pickFirst((tag) => /Serial\s*ATA/i.test(tag))
    || null;

  const normalizedFallbackText = compactSpaces(fallbackText);
  if (!capacityText) {
    const match = normalizedFallbackText.match(/(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
    if (match?.[1] && match?.[2]) {
      capacityText = `${match[1]}${String(match[2]).toUpperCase()}`;
      if (capacityGb == null) {
        capacityGb = toGb(match[1], match[2]);
      }
    }
  }

  if (!interfaceText) {
    const match = normalizedFallbackText.match(/\b(NVMe|SATA|PCIe)\b/i);
    if (match?.[1]) {
      interfaceText = String(match[1]).toUpperCase();
    }
  }

  if (!formFactor) {
    const match = normalizedFallbackText.match(/\b(M\.2|2280|2242|2230|2\.5)\b/i);
    if (match?.[1]) {
      formFactor = match[1];
    }
  }

  return {
    capacityGb: Number.isFinite(capacityGb) ? capacityGb : null,
    capacityText: capacityText || null,
    interfaceText: interfaceText || null,
    formFactor: formFactor || null,
    tagsText: normalizedTags.join(' | ') || null,
  };
}

export function sortArkSsdItems(items: ArkSsdItem[]): ArkSsdItem[] {
  const priceRank = (value: number | null): number => (
    typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  );

  return [...items].sort((left, right) => {
    const priceDifference = priceRank(left.finalPriceYen) - priceRank(right.finalPriceYen);
    if (priceDifference !== 0) {
      return priceDifference;
    }

    return String(left.productNumber || '').localeCompare(String(right.productNumber || ''));
  });
}