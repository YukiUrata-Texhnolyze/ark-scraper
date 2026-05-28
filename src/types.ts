// Rakuten商品アイテム
export interface RakutenItem {
  jan: string;
  title: string;
  price: string;
  points: string;
  url: string;
  soldout: boolean;
  hasVariation: boolean;
  crawledAt: Date;
}

// Amazon商品アイテム
export interface AmazonItem {
  asin: string;
  title: string;
  price: string;
}

// WesternDigital商品アイテム
export interface WDItem {
  jan: string;
  title: string;
  price: string;
  buttonText: string;
  discountPrice: string;
  crawledAt: Date;
}

export interface ArkItemBase {
  url: string;
  sourceUrl: string | null;
  imageUrl: string | null;
  productNumber: string | null;
  makerName: string | null;
  productName: string | null;
  priceYen: number | null;
  priceRaw: string | null;
  originalPriceYen: number | null;
  finalPriceYen: number | null;
  inStock: boolean | null;
  inStockLabel: string | null;
  stockStatus: string | null;
  salePeriodRaw: string | null;
  saleStart: string | null;
  saleEnd: string | null;
  saleEndGuessJst: string | null;
}

export interface ArkMemoryItem extends ArkItemBase {
  memoryTypeLabel: string | null;
  itemTags: string[];
  memoryDdr: string | null;
  memoryCapacityGb: number | null;
  memorySpeed: number | null;
  sticks: number | null;
  memoryCapacityPerStickGb: number | null;
  rawText?: string;
}

export interface ArkSsdItem extends ArkItemBase {
  capacityGb: number | null;
  capacityText: string | null;
  interfaceText: string | null;
  formFactor: string | null;
  tagsText: string | null;
}

// スクレイパー設定
export interface RakutenConfig {
  shopId: string;
  prefix: string;
  csvFileName: string;
}

export interface AmazonConfig {
  merchantId: string;
  prefix: string;
  csvFileName: string;
}

export interface WDConfig {
  startUrl: string;
  prefix: string;
  csvFileName: string;
}

export interface ArkBaseConfig {
  prefix: string;
  csvFileName: string;
  targetUrls: string[];
  artifactRootDir: string;
  timeoutMs: number;
  headed: boolean;
  storageStatePath?: string;
  debug: boolean;
}

export interface ArkMemoryConfig extends ArkBaseConfig {
  maxPages: number;
}

export interface ArkSsdConfig extends ArkBaseConfig {}

export type MarketResearchTarget =
  | 'market-smoke'
  | 'market-official-site'
  | 'market-amazon-search'
  | 'market-bic-search'
  | 'market-bic-parse-html'
  | 'market-amazon-product'
  | 'market-youtube-search'
  | 'market-tiktok-search'
  | 'market-instagram-search'
  | 'market-x-search';

export type MarketOutputFormat = 'csv' | 'jsonl';

export interface MarketResearchViewport {
  width: number;
  height: number;
}

export interface MarketResearchQueryGroups {
  amazon?: string[];
  bic?: string[];
  youtube?: string[];
  tiktok?: string[];
  instagram?: string[];
  x?: string[];
  official?: string[];
  [key: string]: string[] | undefined;
}

export interface MarketResearchProjectConfig {
  project: string;
  locale: string;
  timezone: string;
  viewport: MarketResearchViewport;
  headless?: boolean;
  officialUrls?: string[];
  queries?: MarketResearchQueryGroups;
  loginStateLabel?: string;
  profileName?: string | null;
  outputFormats?: MarketOutputFormat[];
}

export interface MarketResearchConfig extends MarketResearchProjectConfig {}

export interface MarketArtifactErrorInfo {
  name?: string;
  message: string;
  stack?: string;
}

export interface MarketArtifactMetadata {
  project: string;
  target: MarketResearchTarget;
  query?: string | null;
  url: string;
  finalUrl?: string | null;
  crawledAt: string;
  locale: string;
  timezone: string;
  viewport: MarketResearchViewport;
  headless: boolean;
  loginStateLabel: string;
  profileName: string | null;
  blocked: boolean;
  error?: MarketArtifactErrorInfo | null;
}

export interface MarketRunContext {
  target: MarketResearchTarget;
  project: string;
  locale: string;
  timezone: string;
  viewport: MarketResearchViewport;
  headless: boolean;
  query?: string | null;
  url: string;
  finalUrl?: string | null;
  crawledAt: string;
  loginStateLabel: string;
  profileName: string | null;
  blocked: boolean;
}
