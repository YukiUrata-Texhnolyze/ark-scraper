import { resolveMarketBicQueries } from '../config/marketResearchConfig';
import { MarketResearchConfig } from '../types';
import {
  createMarketOutputPaths,
  getMarketOutputFiles,
  normalizeMarketOutputFormats,
  writeMarketOutputs,
} from '../utils/marketOutput';

const TARGET = 'market-bic-search-browsermcp' as const;
const SOURCE = 'bic' as const;

export interface MarketBicSearchBrowserMcpRecord {
  project: string;
  source: typeof SOURCE;
  target: typeof TARGET;
  query: string;
  status: 'pending_browsermcp';
  crawledAt: string;
  notes: string;
}

export interface MarketBicSearchBrowserMcpResult {
  outputFiles: string[];
  records: MarketBicSearchBrowserMcpRecord[];
}

export interface MarketBicSearchBrowserMcpOptions {
  runAt?: Date;
  outputDir?: string;
}

export async function scrapeMarketBicSearchBrowserMcp(
  config: MarketResearchConfig,
  options: MarketBicSearchBrowserMcpOptions = {},
): Promise<MarketBicSearchBrowserMcpResult> {
  const runAt = options.runAt ?? new Date();
  const queries = resolveMarketBicQueries(config);
  const outputFormats = normalizeMarketOutputFormats(config.outputFormats);
  const outputPaths = await createMarketOutputPaths(TARGET, runAt, options.outputDir);
  const records = queries.map<MarketBicSearchBrowserMcpRecord>((query) => ({
    project: config.project,
    source: SOURCE,
    target: TARGET,
    query,
    status: 'pending_browsermcp',
    crawledAt: runAt.toISOString(),
    notes: 'Manual/operator-assisted flow only. Use BrowserMCP under explicit human instruction; this target currently emits query-plan records only.',
  }));

  await writeMarketOutputs(outputPaths, outputFormats, records.map((record) => ({ ...record })));

  const outputFiles = getMarketOutputFiles(outputPaths, outputFormats);
  console.log(`[Market] bic-search-browsermcp manual plan 出力: queries=${records.length}`);
  console.log('[Market] BrowserMCP 実操作は人の指示下で agent / MCP 経由で実行してください');
  console.log(`[Market] 出力: ${outputFiles.join(', ')}`);

  return {
    outputFiles,
    records,
  };
}