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
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  return decodeHtml(patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) ?? "");
}

export function createProductDraftFallback({ productId, sourceUrl, reason = "confirmation-required" }) {
  return {
    mall: "G마켓",
    productId: String(productId),
    sourceUrl,
    name: "",
    price: 0,
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
  const name = decodeHtml(product?.name || metaContent(source, "og:title") || metaContent(source, "twitter:title"))
    .replace(/^G마켓\s*[-–|]\s*/i, "").replace(/\s*[-–|]\s*G마켓\s*$/i, "");
  const price = priceNumber(offers?.price ?? offers?.lowPrice ?? offers?.highPrice) ||
    priceNumber(metaContent(source, "product:price:amount")) || priceNumber(metaContent(source, "og:price:amount"));

  return {
    mall: "G마켓",
    productId: String(productId),
    sourceUrl,
    name,
    price,
    lookupStatus: name || price ? "found" : "confirmation-required",
  };
}
