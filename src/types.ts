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
