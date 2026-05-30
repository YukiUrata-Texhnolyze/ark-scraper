import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { MarketBicSearchRecord } from '../scrapers/marketBicSearch';
import { parseBicSearchDocument } from '../parsers/bicSearchParser';
import { MarketOutputFormat } from '../types';
import {
  createMarketOutputPaths,
  getMarketOutputFiles,
  writeMarketOutputs,
} from '../utils/marketOutput';
import {
  buildBicSearchUrl,
  buildDefaultChromiumLaunchOptions,
  BIC_SEARCH_BASE_URL,
} from '../utils/bicBrowser';

interface CliOptions {
  inputPath: string;
  query: string;
  baseUrl: string;
  finalUrl?: string;
  outputDir?: string;
  maxResults: number;
  outputFormats: MarketOutputFormat[];
}

async function main(): Promise<void> {
  const options = getCliOptions();
  const html = await fs.promises.readFile(options.inputPath, 'utf8');
  const runAt = new Date();
  const searchUrl = buildBicSearchUrl(options.query);
  const finalUrl = options.finalUrl ?? options.baseUrl;
  const artifactDir = path.dirname(path.resolve(options.inputPath));

  const browser = await chromium.launch(buildDefaultChromiumLaunchOptions(true));

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pageData = await page.evaluate(parseBicSearchDocument, {
      baseUrl: options.baseUrl,
      maxResults: options.maxResults,
    });

    const records = buildRecordsFromPageData({
      inputPath: options.inputPath,
      query: options.query,
      searchUrl,
      finalUrl,
      artifactDir,
      crawledAt: runAt.toISOString(),
      pageData,
    });

    const outputPaths = await createMarketOutputPaths('market-bic-parse-html', runAt, options.outputDir);
    await writeMarketOutputs(outputPaths, options.outputFormats, records.map((record) => ({ ...record })));

    const outputFiles = getMarketOutputFiles(outputPaths, options.outputFormats);
    const okCount = records.filter((record) => record.status === 'ok').length;
    const noResultsCount = records.filter((record) => record.status === 'no_results').length;

    console.log(`[Bic HTML] 入力: ${path.resolve(options.inputPath)}`);
    console.log(`[Bic HTML] 完了: ok=${okCount} no_results=${noResultsCount}`);
    console.log(`[Bic HTML] 出力: ${outputFiles.join(', ')}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function buildRecordsFromPageData(params: {
  inputPath: string;
  query: string;
  searchUrl: string;
  finalUrl: string;
  artifactDir: string;
  crawledAt: string;
  pageData: Awaited<ReturnType<typeof parsePageDataType>>;
}): MarketBicSearchRecord[] {
  const status = params.pageData.noResults || params.pageData.items.length === 0 ? 'no_results' : 'ok';

  if (status === 'no_results') {
    return [{
      project: 'manual-bic-html-parse',
      source: 'bic',
      target: 'market-bic-search',
      query: params.query,
      rank: null,
      title: null,
      price: null,
      pointLabel: null,
      stockLabel: null,
      productUrl: null,
      imageUrl: null,
      categoryLabel: null,
      searchUrl: params.searchUrl,
      finalUrl: params.finalUrl,
      status: 'no_results',
      blocked: false,
      crawledAt: params.crawledAt,
      artifactDir: params.artifactDir,
      errorName: null,
      errorMessage: null,
    }];
  }

  return params.pageData.items.map((item) => ({
    project: 'manual-bic-html-parse',
    source: 'bic',
    target: 'market-bic-search',
    query: params.query,
    rank: item.rank,
    title: item.title,
    price: item.price,
    pointLabel: item.pointLabel,
    stockLabel: item.stockLabel,
    productUrl: item.productUrl,
    imageUrl: item.imageUrl,
    categoryLabel: item.categoryLabel,
    searchUrl: params.searchUrl,
    finalUrl: params.finalUrl,
    status: 'ok',
    blocked: false,
    crawledAt: params.crawledAt,
    artifactDir: params.artifactDir,
    errorName: null,
    errorMessage: null,
  }));
}

type ParsePageDataType = typeof parsePageDataType;

function parsePageDataType() {
  return {
    items: [] as Array<{
      rank: number;
      title: string | null;
      price: string | null;
      pointLabel: string | null;
      stockLabel: string | null;
      productUrl: string | null;
      imageUrl: string | null;
      categoryLabel: string | null;
    }>,
    noResults: false,
    pageTitle: null as string | null,
  };
}

function getCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  let inputPath = '';
  let query = '';
  let baseUrl = BIC_SEARCH_BASE_URL;
  let finalUrl: string | undefined;
  let outputDir: string | undefined;
  let maxResults = 20;
  let outputFormats: MarketOutputFormat[] = ['csv', 'jsonl'];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = args[index + 1];

    if ((arg === '--input' || arg === '--query' || arg === '--base-url' || arg === '--final-url' || arg === '--output-dir' || arg === '--max-results' || arg === '--formats') && (!nextValue || nextValue.startsWith('--'))) {
      throw new Error(`${arg} には値が必要です`);
    }

    if (arg === '--input') {
      inputPath = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--query') {
      query = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--base-url') {
      baseUrl = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--final-url') {
      finalUrl = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      outputDir = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--max-results') {
      maxResults = Number(nextValue);
      index += 1;
      continue;
    }

    if (arg === '--formats') {
      outputFormats = nextValue.split(',').map((format) => format.trim()).filter((format): format is MarketOutputFormat => format === 'csv' || format === 'jsonl');
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`不正なオプション: ${arg}`);
    }
  }

  if (!inputPath) {
    throw new Error('--input は必須です');
  }

  if (!query) {
    throw new Error('--query は必須です');
  }

  if (!Number.isFinite(maxResults) || maxResults <= 0) {
    throw new Error('--max-results には1以上の数値を指定してください');
  }

  if (outputFormats.length === 0) {
    outputFormats = ['csv', 'jsonl'];
  }

  return {
    inputPath,
    query,
    baseUrl,
    finalUrl,
    outputDir,
    maxResults,
    outputFormats,
  };
}

main().catch((error) => {
  console.error('[Bic HTML] エラー:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});