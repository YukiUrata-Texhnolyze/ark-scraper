export interface BicSearchCandidate {
  rank: number;
  title: string | null;
  price: string | null;
  pointLabel: string | null;
  stockLabel: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  categoryLabel: string | null;
}

export interface BicSearchPageData {
  items: BicSearchCandidate[];
  noResults: boolean;
  pageTitle: string | null;
}

export interface ParseBicSearchDocumentOptions {
  baseUrl: string;
  maxResults: number;
}

export function parseBicSearchDocument(options: ParseBicSearchDocumentOptions): BicSearchPageData {
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
      return new URL(normalized, options.baseUrl).toString();
    } catch {
      return null;
    }
  };

  const firstText = (root: ParentNode, selectors: string[]): string | null => {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = normalizeText(element?.textContent);
      if (text) {
        return text;
      }
    }

    return null;
  };

  const allTexts = (root: ParentNode, selectors: string[]): string[] => {
    const values: string[] = [];

    for (const selector of selectors) {
      root.querySelectorAll(selector).forEach((element) => {
        const text = normalizeText(element.textContent);
        if (text) {
          values.push(text);
        }
      });
    }

    return values;
  };

  const extractImageUrl = (root: ParentNode): string | null => {
    const image = root.querySelector<HTMLImageElement>('img');
    if (!image) {
      return null;
    }

    const srcset = normalizeText(image.getAttribute('srcset')).split(',')[0]?.trim().split(/\s+/)[0] ?? '';
    return absoluteUrl(image.getAttribute('src') || image.getAttribute('data-src') || srcset);
  };

  const pickFirstMatching = (
    root: ParentNode,
    selectors: string[],
    predicate: (candidate: string) => boolean,
  ): string | null => allTexts(root, selectors).find((candidate) => predicate(candidate)) ?? null;

  const extractPrice = (root: ParentNode): string | null => pickFirstMatching(
    root,
    ['.bcs_price .val', '.bcs_price', '[class*="price"]', 'span', 'p'],
    (candidate) => candidate.length <= 40 && /([¥￥]|円|税込)/.test(candidate) && /[0-9]/.test(candidate),
  );

  const extractPointLabel = (root: ParentNode): string | null => pickFirstMatching(
    root,
    ['.bcs_point span', '.bcs_point', '[class*="point"]', 'span', 'p'],
    (candidate) => candidate.length <= 80 && /(ポイント|還元|%)/.test(candidate),
  );

  const extractStockLabel = (root: ParentNode): string | null => pickFirstMatching(
    root,
    ['.bcs_zaiko', '.bcs_nouki', '[class*="zaiko"]', '[class*="nouki"]', 'button', 'span', 'p'],
    (candidate) => candidate.length <= 120 && /(在庫|お取り寄せ|販売終了|予定数終了|入荷次第|カートに入れる|出荷|送料無料)/.test(candidate),
  );

  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('li.prod_box, #ga_itam_list li[id^="bcs_item"], .bcs_listItem li'),
  ).filter((node) => node.querySelector('a[href*="/bc/item/"]'));

  const seenProductUrls = new Set<string>();
  const items: BicSearchCandidate[] = [];

  for (const node of nodes) {
    const productUrl = absoluteUrl(
      node.querySelector<HTMLAnchorElement>('.bcs_title a, .bcs_comp_title a, a.bcs_item, a[href*="/bc/item/"]')?.getAttribute('href'),
    );
    if (productUrl && seenProductUrls.has(productUrl)) {
      continue;
    }

    const imageAlt = normalizeText(node.querySelector<HTMLImageElement>('img')?.getAttribute('alt')) || null;
    const title = firstText(node, ['.bcs_title a', '.bcs_comp_title a', 'a.bcs_item']) ?? imageAlt;

    if (!title && !productUrl) {
      continue;
    }

    if (productUrl) {
      seenProductUrls.add(productUrl);
    }

    const categoryCandidate = firstText(node, [
      '.bcs_category a',
      '.bcs_category span',
      '[class*="category"] a',
      '[class*="category"] span',
    ]);
    const categoryLabel = categoryCandidate && categoryCandidate !== title ? categoryCandidate : null;

    items.push({
      rank: items.length + 1,
      title,
      price: extractPrice(node),
      pointLabel: extractPointLabel(node),
      stockLabel: extractStockLabel(node),
      productUrl,
      imageUrl: extractImageUrl(node),
      categoryLabel,
    });

    if (items.length >= Math.max(1, options.maxResults)) {
      break;
    }
  }

  const bodyText = normalizeText(document.body?.innerText || '');
  const noResults = [
    '検索に一致する商品は見つかりませんでした',
    '該当する商品がありません',
    '検索結果はありません',
    '結果は見つかりませんでした',
  ].some((pattern) => bodyText.includes(pattern));

  return {
    items,
    noResults,
    pageTitle: normalizeText(document.title) || null,
  };
}