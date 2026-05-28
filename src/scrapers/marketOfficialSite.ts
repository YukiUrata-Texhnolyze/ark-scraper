import { BrowserContext } from 'playwright';
import { resolveMarketOfficialUrls } from '../config/marketResearchConfig';
import { MarketArtifactMetadata, MarketResearchConfig } from '../types';
import {
  createMarketArtifactPaths,
  saveMarketErrorArtifacts,
  saveMarketSuccessArtifacts,
  toMarketArtifactErrorInfo,
} from '../utils/marketArtifacts';
import {
  buildMarketArtifactMetadata,
  isLikelyBlocked,
  isLikelyBlockedByError,
  readMarketPageBodyText,
} from '../utils/marketPage';
import {
  createMarketOutputPaths,
  getMarketOutputFiles,
  normalizeMarketOutputFormats,
  writeMarketOutputs,
} from '../utils/marketOutput';

type MarketOfficialSiteStatus = 'ok' | 'not_found' | 'blocked' | 'error';

interface MarketOfficialSiteSpec {
  label: string | null;
  value: string;
}

interface MarketOfficialSiteFaqItem {
  question: string;
  answer: string | null;
}

interface OfficialSiteDomData {
  title: string | null;
  ogTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  h1Texts: string[];
  bodyText: string;
  descriptionTexts: string[];
  metaPrice: string | null;
  specs: MarketOfficialSiteSpec[];
  faq: MarketOfficialSiteFaqItem[];
  imageUrls: string[];
  videoUrls: string[];
}

interface OfficialSiteJsonLdData {
  productNames: string[];
  prices: string[];
  modelNumbers: string[];
  descriptions: string[];
  specs: MarketOfficialSiteSpec[];
  faq: MarketOfficialSiteFaqItem[];
  imageUrls: string[];
  videoUrls: string[];
  availability: string[];
}

interface OfficialSiteExtractedData {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  h1Texts: string[];
  bodyText: string;
  productName: string | null;
  price: string | null;
  modelNumber: string | null;
  specs: MarketOfficialSiteSpec[];
  faq: MarketOfficialSiteFaqItem[];
  descriptionText: string | null;
  imageUrls: string[];
  videoUrls: string[];
  availability: string | null;
}

export interface MarketOfficialSiteRecord {
  project: string;
  source: 'official-site';
  target: 'market-official-site';
  productUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  status: MarketOfficialSiteStatus;
  productName: string | null;
  price: string | null;
  modelNumber: string | null;
  specs: MarketOfficialSiteSpec[];
  faq: MarketOfficialSiteFaqItem[];
  descriptionText: string | null;
  imageUrls: string[];
  videoUrls: string[];
  availability: string | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  h1Texts: string[];
  blocked: boolean;
  crawledAt: string;
  artifactDir: string;
  errorName: string | null;
  errorMessage: string | null;
}

export interface MarketOfficialSiteResult {
  artifactDirs: string[];
  outputFiles: string[];
  records: MarketOfficialSiteRecord[];
}

export interface MarketOfficialSiteOptions {
  headless: boolean;
  runAt?: Date;
  artifactRootDir?: string;
  outputDir?: string;
  timeoutMs?: number;
}

type MarketOfficialSiteArtifactMetadata = MarketArtifactMetadata & {
  source: 'official-site';
  productUrl: string;
  httpStatus: number | null;
  status: MarketOfficialSiteStatus;
  artifactDir: string;
  title: string | null;
};

const TARGET = 'market-official-site' as const;
const SOURCE = 'official-site' as const;

export async function scrapeMarketOfficialSite(
  context: BrowserContext,
  config: MarketResearchConfig,
  options: MarketOfficialSiteOptions,
): Promise<MarketOfficialSiteResult> {
  const runAt = options.runAt ?? new Date();
  const timeoutMs = options.timeoutMs ?? 60000;
  const officialUrls = resolveMarketOfficialUrls(config);
  const outputFormats = normalizeMarketOutputFormats(config.outputFormats);
  const outputPaths = await createMarketOutputPaths(TARGET, runAt, options.outputDir);
  const records: MarketOfficialSiteRecord[] = [];
  const artifactDirs: string[] = [];

  for (const [index, productUrl] of officialUrls.entries()) {
    const query = config.queries?.official?.[index] ?? null;
    const artifactPaths = createMarketArtifactPaths(
      config.project,
      TARGET,
      runAt,
      options.artifactRootDir,
      buildArtifactLabel(productUrl, index),
    );
    const page = await context.newPage();
    let finalUrl = productUrl;
    let httpStatus: number | null = null;

    artifactDirs.push(artifactPaths.artifactDir);

    try {
      const response = await page.goto(productUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      httpStatus = response?.status() ?? null;
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      finalUrl = page.url() || productUrl;

      const extracted = await extractOfficialSiteData(page, finalUrl);
      const blocked = isLikelyBlocked(httpStatus, extracted.bodyText);
      const status = resolveRecordStatus(httpStatus, blocked);
      const metadata = buildOfficialSiteMetadata({
        config,
        query,
        productUrl,
        finalUrl,
        crawledAt: runAt.toISOString(),
        headless: options.headless,
        blocked,
        httpStatus,
        status,
        artifactDir: artifactPaths.artifactDir,
        title: extracted.title,
      });

      await saveMarketSuccessArtifacts(page, artifactPaths, metadata);
      records.push(buildOfficialSiteRecord({
        project: config.project,
        productUrl,
        finalUrl,
        httpStatus,
        status,
        extracted,
        blocked,
        crawledAt: runAt.toISOString(),
        artifactDir: artifactPaths.artifactDir,
      }));

      console.log(`[Market] official-site ${status}: ${productUrl}`);
    } catch (error) {
      finalUrl = page.url() || finalUrl;

      const partialData = await extractOfficialSiteData(page, finalUrl).catch(() => createEmptyExtractedData());
      const bodyText = partialData.bodyText || await readMarketPageBodyText(page);
      const blocked = isLikelyBlocked(httpStatus, bodyText) || isLikelyBlockedByError(error);
      const status: MarketOfficialSiteStatus = blocked ? 'blocked' : 'error';
      const errorInfo = toMarketArtifactErrorInfo(error);
      const metadata = buildOfficialSiteMetadata({
        config,
        query,
        productUrl,
        finalUrl,
        crawledAt: runAt.toISOString(),
        headless: options.headless,
        blocked,
        httpStatus,
        status,
        artifactDir: artifactPaths.artifactDir,
        title: partialData.title,
        error: errorInfo,
      });

      await saveMarketErrorArtifacts(page, artifactPaths, metadata);
      records.push(buildOfficialSiteRecord({
        project: config.project,
        productUrl,
        finalUrl,
        httpStatus,
        status,
        extracted: partialData,
        blocked,
        crawledAt: runAt.toISOString(),
        artifactDir: artifactPaths.artifactDir,
        errorName: errorInfo.name ?? null,
        errorMessage: errorInfo.message,
      }));

      console.warn(`[Market] official-site ${status}: ${productUrl} (${errorInfo.message})`);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  await writeMarketOutputs(
    outputPaths,
    outputFormats,
    records.map((record) => ({ ...record })),
  );

  const outputFiles = getMarketOutputFiles(outputPaths, outputFormats);
  const statusSummary = summarizeStatuses(records);

  console.log(`[Market] official-site 完了: ok=${statusSummary.ok} not_found=${statusSummary.not_found} blocked=${statusSummary.blocked} error=${statusSummary.error}`);
  console.log(`[Market] 出力: ${outputFiles.join(', ')}`);

  return {
    artifactDirs,
    outputFiles,
    records,
  };
}

async function extractOfficialSiteData(page: import('playwright').Page, baseUrl: string): Promise<OfficialSiteExtractedData> {
  const [domData, jsonLdTexts] = await Promise.all([
    extractDomData(page),
    page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []),
  ]);
  const jsonLdData = extractJsonLdData(jsonLdTexts, baseUrl);

  return {
    title: domData.title,
    metaDescription: domData.metaDescription,
    canonicalUrl: domData.canonicalUrl,
    h1Texts: uniqueStrings(domData.h1Texts),
    bodyText: domData.bodyText,
    productName: firstNonEmpty([
      jsonLdData.productNames[0],
      domData.ogTitle,
      domData.h1Texts[0],
      domData.title,
    ]),
    price: firstNonEmpty([
      jsonLdData.prices[0],
      domData.metaPrice,
      findPriceInText(domData.bodyText),
    ]),
    modelNumber: firstNonEmpty([
      jsonLdData.modelNumbers[0],
      findModelNumberInText(domData.bodyText),
      extractModelNumberFromUrl(baseUrl),
    ]),
    specs: uniqueSpecItems([...jsonLdData.specs, ...domData.specs]),
    faq: uniqueFaqItems([...jsonLdData.faq, ...domData.faq]),
    descriptionText: trimDescription(firstNonEmpty([
      jsonLdData.descriptions[0],
      domData.descriptionTexts[0],
      domData.bodyText,
    ])),
    imageUrls: uniqueStrings([...jsonLdData.imageUrls, ...domData.imageUrls]),
    videoUrls: uniqueStrings([...jsonLdData.videoUrls, ...domData.videoUrls]),
    availability: firstNonEmpty([
      normalizeAvailability(jsonLdData.availability[0]),
      detectAvailabilityFromText(domData.bodyText),
    ]),
  };
}

async function extractDomData(page: import('playwright').Page): Promise<OfficialSiteDomData> {
  return page.evaluate(() => {
    const normalizeText = (value: string | null | undefined): string => String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const absoluteUrl = (value: string | null | undefined): string | null => {
      const normalized = normalizeText(value);
      if (!normalized) {
        return null;
      }

      try {
        return new URL(normalized, window.location.href).toString();
      } catch {
        return null;
      }
    };

    const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
      const seen = new Set<string>();
      const results: string[] = [];

      for (const value of values) {
        const normalized = normalizeText(value);
        if (!normalized || seen.has(normalized)) {
          continue;
        }

        seen.add(normalized);
        results.push(normalized);
      }

      return results;
    };

    const specs: MarketOfficialSiteSpec[] = [];
    const faq: MarketOfficialSiteFaqItem[] = [];

    const pushSpec = (label: string | null, value: string | null | undefined): void => {
      const normalizedValue = normalizeText(value);
      if (!normalizedValue) {
        return;
      }

      const normalizedLabel = normalizeText(label) || null;
      if (specs.some((entry) => entry.label === normalizedLabel && entry.value === normalizedValue)) {
        return;
      }

      specs.push({ label: normalizedLabel, value: normalizedValue });
    };

    const pushFaq = (question: string | null | undefined, answer: string | null | undefined): void => {
      const normalizedQuestion = normalizeText(question);
      if (!normalizedQuestion) {
        return;
      }

      const normalizedAnswer = normalizeText(answer) || null;
      if (faq.some((entry) => entry.question === normalizedQuestion && entry.answer === normalizedAnswer)) {
        return;
      }

      faq.push({ question: normalizedQuestion, answer: normalizedAnswer });
    };

    const readMeta = (selectors: string[]): string | null => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const content = normalizeText(element?.getAttribute('content'));
        if (content) {
          return content;
        }
      }

      return null;
    };

    const readSrcsetUrls = (value: string | null | undefined): string[] => {
      const normalized = normalizeText(value);
      if (!normalized) {
        return [];
      }

      return normalized
        .split(',')
        .map((entry) => entry.trim().split(/\s+/)[0])
        .map((entry) => absoluteUrl(entry))
        .filter((entry): entry is string => Boolean(entry));
    };

    const headingSelectors = 'h1,h2,h3,h4,h5,h6';
    const isHeadingElement = (element: Element | null): boolean => Boolean(element && /^h[1-6]$/i.test(element.tagName));

    const collectSiblingTexts = (heading: Element): string[] => {
      const results: string[] = [];
      let current = heading.nextElementSibling;
      let guard = 0;

      while (current && guard < 8 && !isHeadingElement(current)) {
        if (current.matches('table')) {
          current.querySelectorAll('tr').forEach((row) => {
            const values = Array.from(row.querySelectorAll('th,td'))
              .map((cell) => normalizeText(cell.textContent))
              .filter(Boolean);
            if (values.length >= 2) {
              results.push(`${values[0]}: ${values.slice(1).join(' ')}`);
            }
          });
        } else if (current.matches('dl')) {
          current.querySelectorAll('dt').forEach((dt) => {
            const dd = dt.nextElementSibling;
            const label = normalizeText(dt.textContent);
            const value = normalizeText(dd?.textContent);
            if (label && value) {
              results.push(`${label}: ${value}`);
            }
          });
        } else {
          const listTexts = Array.from(current.querySelectorAll('li'))
            .map((element) => normalizeText(element.textContent))
            .filter(Boolean);

          if (listTexts.length > 0) {
            results.push(...listTexts);
          } else {
            const text = normalizeText(current.textContent);
            if (text) {
              results.push(text);
            }
          }
        }

        current = current.nextElementSibling;
        guard += 1;
      }

      return uniqueStrings(results);
    };

    document.querySelectorAll('table').forEach((table) => {
      table.querySelectorAll('tr').forEach((row) => {
        const values = Array.from(row.querySelectorAll('th,td'))
          .map((cell) => normalizeText(cell.textContent))
          .filter(Boolean);

        if (values.length >= 2) {
          pushSpec(values[0], values.slice(1).join(' '));
        }
      });
    });

    document.querySelectorAll('dl').forEach((dl) => {
      dl.querySelectorAll('dt').forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (!dd || dd.tagName.toLowerCase() !== 'dd') {
          return;
        }

        pushSpec(dt.textContent, dd.textContent);
      });
    });

    Array.from(document.querySelectorAll(headingSelectors))
      .filter((heading) => {
        const text = normalizeText(heading.textContent).toLowerCase();
        return ['仕様', 'スペック', 'spec', 'specification', 'specifications'].some((keyword) => text.includes(keyword));
      })
      .forEach((heading) => {
        collectSiblingTexts(heading).forEach((value) => pushSpec(null, value));
      });

    document.querySelectorAll('details').forEach((details) => {
      const summary = details.querySelector('summary');
      const question = normalizeText(summary?.textContent);
      const cloned = details.cloneNode(true) as HTMLElement;
      cloned.querySelector('summary')?.remove();
      pushFaq(question, normalizeText(cloned.textContent));
    });

    Array.from(document.querySelectorAll(headingSelectors))
      .filter((heading) => {
        const text = normalizeText(heading.textContent).toLowerCase();
        return ['faq', 'よくある質問', 'q&a'].some((keyword) => text.includes(keyword));
      })
      .forEach((heading) => {
        const entries = collectSiblingTexts(heading);

        for (let index = 0; index < entries.length; index += 1) {
          const current = entries[index];
          const sameLineMatch = current.match(/^(?:q|question|質問)[:：]?\s*(.+?)(?:\s+(?:a|answer|回答)[:：]?\s*(.+))$/i);
          if (sameLineMatch) {
            pushFaq(sameLineMatch[1], sameLineMatch[2]);
            continue;
          }

          const questionMatch = current.match(/^(?:q|question|質問)[:：]?\s*(.+)$/i);
          if (questionMatch) {
            const next = entries[index + 1];
            const answerMatch = next?.match(/^(?:a|answer|回答)[:：]?\s*(.+)$/i);
            if (answerMatch) {
              pushFaq(questionMatch[1], answerMatch[1]);
              index += 1;
              continue;
            }

            pushFaq(questionMatch[1], null);
            continue;
          }

          if (/[?？]$/.test(current)) {
            pushFaq(current, entries[index + 1] ?? null);
            index += 1;
          }
        }
      });

    const mainElement = document.querySelector('main, article, [role="main"]') as HTMLElement | null;
    const mainText = normalizeText(mainElement?.innerText || document.body?.innerText || '');
    const descriptionTexts = uniqueStrings([
      readMeta(['meta[name="description"]', 'meta[property="og:description"]']),
      ...Array.from(document.querySelectorAll('main p, article p, [role="main"] p')).slice(0, 6)
        .map((element) => normalizeText(element.textContent))
        .filter(Boolean),
    ]);

    const imageUrls = uniqueStrings([
      absoluteUrl(readMeta(['meta[property="og:image"]'])),
      ...Array.from(document.images)
        .flatMap((image) => [absoluteUrl(image.getAttribute('src')), ...readSrcsetUrls(image.getAttribute('srcset'))]),
    ]);

    const videoUrls = uniqueStrings([
      ...Array.from(document.querySelectorAll('video, source'))
        .map((element) => absoluteUrl(element.getAttribute('src'))),
      ...Array.from(document.querySelectorAll('iframe'))
        .map((element) => absoluteUrl(element.getAttribute('src')))
        .filter((value) => {
          const normalized = normalizeText(value).toLowerCase();
          return normalized.includes('youtube.com')
            || normalized.includes('youtu.be')
            || normalized.includes('vimeo.com');
        }),
    ]);

    return {
      title: normalizeText(document.title) || null,
      ogTitle: readMeta(['meta[property="og:title"]']),
      metaDescription: readMeta(['meta[name="description"]', 'meta[property="og:description"]']),
      canonicalUrl: absoluteUrl(document.querySelector('link[rel="canonical"]')?.getAttribute('href')),
      h1Texts: uniqueStrings(Array.from(document.querySelectorAll('h1')).map((element) => element.textContent || '')),
      bodyText: mainText,
      descriptionTexts,
      metaPrice: readMeta(['meta[property="product:price:amount"]']),
      specs,
      faq,
      imageUrls,
      videoUrls,
    };
  });
}

function extractJsonLdData(jsonLdTexts: string[], baseUrl: string): OfficialSiteJsonLdData {
  const nodes: Array<Record<string, unknown>> = [];

  for (const text of jsonLdTexts) {
    const trimmed = text.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      collectJsonLdNodes(parsed, nodes);
    } catch {
      continue;
    }
  }

  const productNames: string[] = [];
  const prices: string[] = [];
  const modelNumbers: string[] = [];
  const descriptions: string[] = [];
  const specs: MarketOfficialSiteSpec[] = [];
  const faq: MarketOfficialSiteFaqItem[] = [];
  const imageUrls: string[] = [];
  const videoUrls: string[] = [];
  const availability: string[] = [];

  for (const node of nodes) {
    if (hasJsonLdType(node, 'Product')) {
      pushIfString(productNames, node.name);
      pushIfString(modelNumbers, node.sku);
      pushIfString(modelNumbers, node.mpn);
      pushIfString(modelNumbers, node.model);
      pushIfString(modelNumbers, node.productID);
      pushIfString(descriptions, stripHtmlTags(asString(node.description)));

      for (const imageValue of normalizeJsonLdUrlValues(node.image, baseUrl)) {
        imageUrls.push(imageValue);
      }

      for (const offer of toObjectArray(node.offers)) {
        const offerPrice = firstNonEmpty([
          formatPriceValue(offer.price, offer.priceCurrency),
          formatPriceValue(readNestedValue(offer, ['priceSpecification', 'price']), readNestedValue(offer, ['priceCurrency'])),
          formatPriceValue(readNestedValue(offer, ['priceSpecification', 'price']), readNestedValue(offer, ['priceSpecification', 'priceCurrency'])),
        ]);
        if (offerPrice) {
          prices.push(offerPrice);
        }

        pushIfString(availability, offer.availability);
      }

      for (const additionalProperty of toObjectArray(node.additionalProperty)) {
        const label = asString(additionalProperty.name) ?? asString(additionalProperty.propertyID);
        const value = asString(additionalProperty.value) ?? asString(additionalProperty.description);
        if (value) {
          const normalizedValue = stripHtmlTags(value);
          if (normalizedValue) {
            specs.push({ label: label ?? null, value: normalizedValue });
          }
        }
      }

      for (const videoValue of normalizeJsonLdUrlValues(node.video, baseUrl)) {
        videoUrls.push(videoValue);
      }
    }

    if (hasJsonLdType(node, 'FAQPage')) {
      extractJsonLdFaqItems(node.mainEntity).forEach((entry) => faq.push(entry));
    }

    if (hasJsonLdType(node, 'Question')) {
      const entry = toFaqEntry(node);
      if (entry) {
        faq.push(entry);
      }
    }

    if (hasJsonLdType(node, 'VideoObject')) {
      for (const videoValue of normalizeJsonLdUrlValues(node.contentUrl, baseUrl)) {
        videoUrls.push(videoValue);
      }
      for (const videoValue of normalizeJsonLdUrlValues(node.embedUrl, baseUrl)) {
        videoUrls.push(videoValue);
      }
      for (const videoValue of normalizeJsonLdUrlValues(node.url, baseUrl)) {
        videoUrls.push(videoValue);
      }
    }
  }

  return {
    productNames: uniqueStrings(productNames),
    prices: uniqueStrings(prices),
    modelNumbers: uniqueStrings(modelNumbers),
    descriptions: uniqueStrings(descriptions),
    specs: uniqueSpecItems(specs),
    faq: uniqueFaqItems(faq),
    imageUrls: uniqueStrings(imageUrls),
    videoUrls: uniqueStrings(videoUrls),
    availability: uniqueStrings(availability),
  };
}

function buildOfficialSiteMetadata(params: {
  config: MarketResearchConfig;
  query: string | null;
  productUrl: string;
  finalUrl: string;
  crawledAt: string;
  headless: boolean;
  blocked: boolean;
  httpStatus: number | null;
  status: MarketOfficialSiteStatus;
  artifactDir: string;
  title: string | null;
  error?: MarketArtifactMetadata['error'];
}): MarketOfficialSiteArtifactMetadata {
  return {
    ...buildMarketArtifactMetadata({
      config: params.config,
      target: TARGET,
      query: params.query,
      url: params.productUrl,
      finalUrl: params.finalUrl,
      crawledAt: params.crawledAt,
      headless: params.headless,
      blocked: params.blocked,
      error: params.error,
    }),
    source: SOURCE,
    productUrl: params.productUrl,
    httpStatus: params.httpStatus,
    status: params.status,
    artifactDir: params.artifactDir,
    title: params.title,
  };
}

function buildOfficialSiteRecord(params: {
  project: string;
  productUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  status: MarketOfficialSiteStatus;
  extracted: OfficialSiteExtractedData;
  blocked: boolean;
  crawledAt: string;
  artifactDir: string;
  errorName?: string | null;
  errorMessage?: string | null;
}): MarketOfficialSiteRecord {
  return {
    project: params.project,
    source: SOURCE,
    target: TARGET,
    productUrl: params.productUrl,
    finalUrl: params.finalUrl,
    httpStatus: params.httpStatus,
    status: params.status,
    productName: params.extracted.productName,
    price: params.extracted.price,
    modelNumber: params.extracted.modelNumber,
    specs: params.extracted.specs,
    faq: params.extracted.faq,
    descriptionText: params.extracted.descriptionText,
    imageUrls: params.extracted.imageUrls,
    videoUrls: params.extracted.videoUrls,
    availability: params.extracted.availability,
    title: params.extracted.title,
    metaDescription: params.extracted.metaDescription,
    canonicalUrl: params.extracted.canonicalUrl,
    h1Texts: params.extracted.h1Texts,
    blocked: params.blocked,
    crawledAt: params.crawledAt,
    artifactDir: params.artifactDir,
    errorName: params.errorName ?? null,
    errorMessage: params.errorMessage ?? null,
  };
}

function createEmptyExtractedData(): OfficialSiteExtractedData {
  return {
    title: null,
    metaDescription: null,
    canonicalUrl: null,
    h1Texts: [],
    bodyText: '',
    productName: null,
    price: null,
    modelNumber: null,
    specs: [],
    faq: [],
    descriptionText: null,
    imageUrls: [],
    videoUrls: [],
    availability: null,
  };
}

function resolveRecordStatus(httpStatus: number | null, blocked: boolean): MarketOfficialSiteStatus {
  if (blocked) {
    return 'blocked';
  }

  if (httpStatus === 404) {
    return 'not_found';
  }

  if (httpStatus !== null && httpStatus >= 400) {
    return 'error';
  }

  return 'ok';
}

function summarizeStatuses(records: MarketOfficialSiteRecord[]): Record<MarketOfficialSiteStatus, number> {
  return records.reduce<Record<MarketOfficialSiteStatus, number>>((counts, record) => {
    counts[record.status] += 1;
    return counts;
  }, {
    ok: 0,
    not_found: 0,
    blocked: 0,
    error: 0,
  });
}

function buildArtifactLabel(productUrl: string, index: number): string {
  const indexLabel = String(index + 1).padStart(2, '0');

  try {
    const parsedUrl = new URL(productUrl);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const slug = [parsedUrl.hostname, ...pathSegments].join('-') || 'root';
    return `${indexLabel}-${slug}`;
  } catch {
    return `${indexLabel}-${productUrl}`;
  }
}

function normalizeAvailability(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (lowered.includes('instock') || lowered.includes('in stock') || lowered.includes('available') || lowered.includes('在庫あり')) {
    return 'in_stock';
  }
  if (lowered.includes('outofstock') || lowered.includes('out of stock') || lowered.includes('sold out') || lowered.includes('売り切れ') || lowered.includes('在庫なし')) {
    return 'out_of_stock';
  }
  if (lowered.includes('preorder') || lowered.includes('pre-order')) {
    return 'preorder';
  }

  return normalized;
}

function detectAvailabilityFromText(text: string): string | null {
  const normalized = text.toLowerCase();
  if (normalized.includes('在庫あり')) {
    return 'in_stock';
  }
  if (normalized.includes('売り切れ') || normalized.includes('在庫なし') || normalized.includes('sold out') || normalized.includes('out of stock')) {
    return 'out_of_stock';
  }
  if (normalized.includes('available') || normalized.includes('in stock')) {
    return 'in_stock';
  }

  return null;
}

function findPriceInText(text: string): string | null {
  const match = text.match(/(?:¥|￥)\s*[0-9][0-9,]*(?:\.[0-9]+)?|[0-9][0-9,]*(?:\.[0-9]+)?\s*円/);
  return match?.[0]?.trim() ?? null;
}

function findModelNumberInText(text: string): string | null {
  const match = text.match(/\b[A-Z]{1,6}-[A-Z0-9]{2,}[A-Z0-9-]*\b/);
  return match?.[0] ?? null;
}

function extractModelNumberFromUrl(value: string): string | null {
  try {
    const parsedUrl = new URL(value);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const lastSegment = pathSegments[pathSegments.length - 1];
    return lastSegment ? decodeURIComponent(lastSegment) : null;
  } catch {
    return null;
  }
}

function trimDescription(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length <= 12000) {
    return normalized;
  }

  return `${normalized.slice(0, 12000)}...`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(normalized);
  }

  return results;
}

function uniqueSpecItems(values: MarketOfficialSiteSpec[]): MarketOfficialSiteSpec[] {
  const seen = new Set<string>();
  const results: MarketOfficialSiteSpec[] = [];

  for (const value of values) {
    const normalized = {
      label: value.label?.trim() || null,
      value: value.value.trim(),
    };
    if (!normalized.value) {
      continue;
    }

    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function uniqueFaqItems(values: MarketOfficialSiteFaqItem[]): MarketOfficialSiteFaqItem[] {
  const seen = new Set<string>();
  const results: MarketOfficialSiteFaqItem[] = [];

  for (const value of values) {
    const normalized = {
      question: value.question.trim(),
      answer: value.answer?.trim() || null,
    };
    if (!normalized.question) {
      continue;
    }

    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function collectJsonLdNodes(value: unknown, nodes: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectJsonLdNodes(entry, nodes));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  nodes.push(value);
  Object.values(value).forEach((entry) => collectJsonLdNodes(entry, nodes));
}

function hasJsonLdType(node: Record<string, unknown>, expectedType: string): boolean {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types
    .map((value) => String(value ?? '').toLowerCase())
    .includes(expectedType.toLowerCase());
}

function extractJsonLdFaqItems(value: unknown): MarketOfficialSiteFaqItem[] {
  return toObjectArray(value)
    .map((entry) => toFaqEntry(entry))
    .filter((entry): entry is MarketOfficialSiteFaqItem => Boolean(entry));
}

function toFaqEntry(node: Record<string, unknown>): MarketOfficialSiteFaqItem | null {
  const question = asString(node.name);
  const acceptedAnswer = toObjectArray(node.acceptedAnswer)[0] ?? null;
  const answer = acceptedAnswer
    ? stripHtmlTags(asString(acceptedAnswer.text) ?? asString(acceptedAnswer.name))
    : null;

  if (!question) {
    return null;
  }

  return {
    question,
    answer,
  };
}

function normalizeJsonLdUrlValues(value: unknown, baseUrl: string): string[] {
  const results: string[] = [];

  if (Array.isArray(value)) {
    value.forEach((entry) => {
      normalizeJsonLdUrlValues(entry, baseUrl).forEach((normalized) => results.push(normalized));
    });
    return uniqueStrings(results);
  }

  if (typeof value === 'string') {
    const normalized = resolveAbsoluteUrl(value, baseUrl);
    return normalized ? [normalized] : [];
  }

  if (isRecord(value)) {
    return uniqueStrings([
      resolveAbsoluteUrl(asString(value.url), baseUrl),
      resolveAbsoluteUrl(asString(value.contentUrl), baseUrl),
      resolveAbsoluteUrl(asString(value.embedUrl), baseUrl),
    ]);
  }

  return [];
}

function formatPriceValue(price: unknown, currency: unknown): string | null {
  const normalizedPrice = asString(price);
  if (!normalizedPrice) {
    return null;
  }

  const normalizedCurrency = asString(currency);
  return normalizedCurrency ? `${normalizedCurrency} ${normalizedPrice}` : normalizedPrice;
}

function readNestedValue(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function toObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  return isRecord(value) ? [value] : [];
}

function pushIfString(values: string[], value: unknown): void {
  const normalized = asString(value);
  if (normalized) {
    values.push(normalized);
  }
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s{2,}/g, ' ').trim();
    return normalized || null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function stripHtmlTags(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return normalized || null;
}

function resolveAbsoluteUrl(value: string | null, baseUrl: string): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}