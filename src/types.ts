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
