const BOT_PAGE = /(잠시만\s*기다리십시오|봇\s*\(?(?:Bot)?\)?\s*확인|간단한\s*확인\s*안내)/i;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const decodeHtml = (value) => clean(String(value ?? "")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16))));

const priceNumber = (value) => {
  const match = String(value ?? "").match(/\d[\d,]*(?:\.\d+)?/);
  const number = match ? Number(match[0].replaceAll(",", "")) : 0;
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};

function collectProducts(value, products) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((entry) => collectProducts(entry, products)); return; }
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => String(type).toLowerCase() === "product")) products.push(value);
  Object.values(value).forEach((entry) => collectProducts(entry, products));
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]+content\\s*=\\s*["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*>`, "i"),
  ];
  return decodeHtml(patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) ?? "");
}

function mostFrequentWon(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const candidates = [...text.matchAll(/([\d,]{3,12})\s*원/g)]
    .map((match) => priceNumber(match[1]))
    .filter((price) => price >= 100 && price <= 50_000_000);
  if (!candidates.length) return 0;
  const frequency = new Map();
  candidates.forEach((price) => frequency.set(price, (frequency.get(price) ?? 0) + 1));
  return [...frequency.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
}

export function createProductDraftFallback({ productId, sourceUrl, reason = "confirmation-required" }) {
  return {
    mall: "G마켓",
    productId: String(productId),
    sourceUrl,
    name: "",
    price: 0,
    currency: null,
    priceRange: null,
    source: null,
    confidence: 0,
    notes: [reason === "blocked"
      ? "쇼핑몰이 공개 상품정보 조회를 막았습니다. 원본을 보며 빈칸을 확인하세요."
      : "공개 상품정보를 확인하지 못했습니다. 원본을 보며 빈칸을 확인하세요."],
    lookupStatus: reason,
  };
}

export function parsePublicProductHtml(html, { productId, sourceUrl }) {
  const source = String(html ?? "");
  if (BOT_PAGE.test(source.slice(0, 20000))) {
    return createProductDraftFallback({ productId, sourceUrl, reason: "blocked" });
  }

  const products = [];
  for (const match of source.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectProducts(JSON.parse(match[1]), products); } catch { /* 다른 공개 메타데이터를 계속 확인 */ }
  }
  const product = products[0];
  const offers = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  const notes = [];
  let name = decodeHtml(product?.name);
  let price = priceNumber(offers?.price ?? offers?.lowPrice ?? offers?.highPrice);
  let currency = clean(offers?.priceCurrency) || null;
  let priceRange = null;
  let priceSource = price ? "JSON-LD" : null;
  let confidence = price ? 0.95 : 0;

  const lowPrice = priceNumber(offers?.lowPrice);
  const highPrice = priceNumber(offers?.highPrice);
  if (lowPrice && highPrice && lowPrice !== highPrice) priceRange = [lowPrice, highPrice];

  if (!price) {
    const metaPrice = metaContent(source, "product:price:amount") || metaContent(source, "og:price:amount");
    price = priceNumber(metaPrice);
    if (price) { priceSource = "메타 태그"; confidence = 0.85; }
    currency ||= metaContent(source, "product:price:currency") || metaContent(source, "og:price:currency") || null;
  }
  if (!price) {
    price = priceNumber(metaContent(source, "price"));
    if (price) { priceSource = "itemprop"; confidence = 0.8; }
  }
  if (!price) {
    price = mostFrequentWon(source);
    if (price) {
      priceSource = "본문 추정";
      confidence = 0.5;
      notes.push("본문에서 가장 자주 표시된 가격입니다. 실제 선택 옵션 가격과 대조하세요.");
    }
  }

  if (!name) {
    const h1 = decodeHtml(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " "));
    const title = decodeHtml(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    name = metaContent(source, "og:title") || metaContent(source, "twitter:title") || h1 || title;
  }
  name = decodeHtml(name).replace(/^G마켓\s*[-–|]\s*/i, "").replace(/\s*[-–|]\s*G마켓\s*$/i, "");

  if (priceRange) {
    notes.push(`옵션에 따라 ${priceRange[0].toLocaleString()}~${priceRange[1].toLocaleString()}원입니다. 선택 옵션 가격을 확인하세요.`);
    confidence = Math.min(confidence, 0.6);
  }
  if (currency && !/KRW|원/i.test(currency)) {
    notes.push(`통화가 ${currency}입니다. 원화 예상단가를 직접 입력하세요.`);
    confidence = 0.3;
  }
  if (!price) notes.push("가격을 찾지 못했습니다. 예상단가를 직접 입력하세요.");
  if (!name) notes.push("상품명을 찾지 못했습니다. 내용을 직접 입력하세요.");

  return {
    mall: "G마켓",
    productId: String(productId),
    sourceUrl,
    name,
    price,
    currency,
    priceRange,
    source: priceSource,
    confidence,
    notes,
    lookupStatus: name || price ? "found" : "confirmation-required",
  };
}
