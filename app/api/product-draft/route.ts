import { createProductDraftFallback, parsePublicProductHtml } from "../../productDraft.mjs";

const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "Cache-Control": "public, max-age=300" },
});

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const mall = requestUrl.searchParams.get("mall");
  const productId = requestUrl.searchParams.get("productId") ?? "";
  if (mall !== "gmarket" || !/^\d{6,20}$/.test(productId)) {
    return json({ error: "지원하지 않는 상품 링크입니다." }, 400);
  }

  const sourceUrl = `https://item.gmarket.co.kr/Item?goodscode=${productId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(sourceUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "User-Agent": "QuoteReview/1.0 (+https://school-quote-review.climbing1126.chatgpt.site)",
      },
    });
    if (!response.ok) return json(createProductDraftFallback({ productId, sourceUrl }));
    const html = await response.text();
    if (html.length > 3_000_000) return json(createProductDraftFallback({ productId, sourceUrl }));
    return json(parsePublicProductHtml(html, { productId, sourceUrl }));
  } catch {
    return json(createProductDraftFallback({ productId, sourceUrl }));
  } finally {
    clearTimeout(timeout);
  }
}
