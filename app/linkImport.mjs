import { parseOrderText } from "./orderTextParser.mjs";

export function normalizeShoppingUrl(value) {
  const input = String(value ?? "").trim();
  if (!input) throw new Error("쇼핑몰 장바구니 또는 주문 링크를 입력해 주세요.");
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) throw new Error("http 또는 https 쇼핑몰 링크만 사용할 수 있습니다.");
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
    throw new Error("공개 쇼핑몰 링크만 사용할 수 있습니다.");
  }
  url.hash = "";
  return url.toString();
}

export function extractStructuredOrder(doc = document, sourceUrl = location.href, requireVisible = true) {
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const textOf = (element) => clean(element?.innerText || element?.textContent);
  const isVisible = (element) => {
    if (!requireVisible) return true;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const moneyValues = (value) => [...String(value).matchAll(/(?:₩\s*)?(\d{1,3}(?:,\d{3})+|\d{3,})\s*원/g)]
    .map((match) => Number(match[1].replaceAll(",", ""))).filter((number) => Number.isFinite(number) && number >= 0);
  const controlText = /(장바구니|주문내역|배송조회|리뷰|문의|구매확정|쿠폰|할인|포인트|합계|총액|결제금액|주문금액)/;
  const nameSelectors = [
    ["[itemprop='name']", 110], ["[data-testid*='name']", 105], ["[data-testid*='title']", 100],
    ["a[href*='product']", 95], ["a[href*='item']", 92], ["h2, h3, h4", 90],
    ["[class*='product'][class*='name'], [class*='item'][class*='name']", 88],
    ["[class*='product'][class*='title'], [class*='item'][class*='title']", 86],
    ["[class*='name'], [class*='title'], strong", 65], ["img[alt]", 60],
  ];

  const nameFor = (row) => {
    const candidates = [];
    for (const [selector, baseScore] of nameSelectors) {
      for (const node of row.querySelectorAll(selector)) {
        const value = clean(node.getAttribute?.("alt") || node.getAttribute?.("title") || node.textContent);
        if (value.length < 2 || value.length > 180 || /^\d[\d,]*\s*원$/.test(value) || controlText.test(value)) continue;
        let score = baseScore;
        if (value.length >= 5 && value.length <= 100) score += 8;
        if (/^(옵션|규격|수량|단가|금액)\b/.test(value)) score -= 30;
        candidates.push({ value, score });
      }
    }
    candidates.sort((left, right) => right.score - left.score || left.value.length - right.value.length);
    return candidates[0] ?? null;
  };

  const rowLooksLikeProduct = (row) => {
    const value = textOf(row);
    if (!isVisible(row) || value.length < 8 || value.length > 1600 || moneyValues(value).length === 0) return false;
    if (!row.querySelector("img, a[href], input, select, [itemprop='name'], [data-product-id], [data-item-id]")) return false;
    return Boolean(nameFor(row));
  };

  const rowSelectors = [
    "[itemtype*='Product']", "[itemprop='itemListElement']", "[data-product-id]", "[data-item-id]", "[data-sku]",
    "[data-testid*='order-item']", "[data-testid*='product-item']", "[data-testid*='cart-item']",
    "[class*='order-item']", "[class*='orderItem']", "[class*='product-item']", "[class*='productItem']",
    "[class*='cart-item']", "[class*='cartItem']", "li[class*='order']", "li[class*='product']", "li[class*='cart']", "table tbody tr",
  ];
  const semanticRows = [...doc.querySelectorAll(rowSelectors.join(","))].filter(rowLooksLikeProduct);
  let rows = semanticRows.filter((row) => !semanticRows.some((other) => other !== row && row.contains(other)));

  if (!rows.length) {
    const priceNodes = [...doc.querySelectorAll("[itemprop='price'], [data-price], [class*='price'], [class*='amount'], strong, em")]
      .filter((node) => isVisible(node) && moneyValues(textOf(node)).length > 0);
    const inferred = [];
    for (const priceNode of priceNodes) {
      let parent = priceNode.parentElement;
      for (let depth = 0; parent && depth < 7; depth += 1, parent = parent.parentElement) {
        if (rowLooksLikeProduct(parent)) { inferred.push(parent); break; }
      }
    }
    rows = inferred.filter((row, index) => inferred.indexOf(row) === index)
      .filter((row) => !inferred.some((other) => other !== row && row.contains(other)));
  }

  const seen = new Set();
  rows = rows.filter((row) => {
    const key = textOf(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);

  const items = rows.flatMap((row) => {
    const rowText = textOf(row);
    const name = nameFor(row);
    if (!name) return [];
    const warnings = [];
    if (name.score < 85) warnings.push("V03");

    let quantity = 0;
    const quantityControl = row.querySelector("input[type='number'], input[name*='quantity'], input[name*='qty'], select[name*='quantity'], select[name*='qty'], [data-quantity]");
    if (quantityControl) quantity = Number(quantityControl.value || quantityControl.getAttribute("data-quantity") || quantityControl.getAttribute("value"));
    const explicitQuantity = rowText.match(/(?:수량|quantity|qty)\s*[:：x×]?\s*(\d{1,4})/i) ?? rowText.match(/(?:^|\s)[x×]\s*(\d{1,4})(?:\s|$)/i);
    if (!Number.isInteger(quantity) || quantity < 1) quantity = explicitQuantity ? Number(explicitQuantity[1]) : 1;
    if (!quantityControl && !explicitQuantity) warnings.push("V04");

    const priceCandidates = [];
    const priceNodes = row.querySelectorAll("[itemprop='price'], [data-price], [data-sale-price], [class*='price'], [class*='amount'], [class*='total'], [class*='sum'], strong, em");
    for (const node of priceNodes) {
      const context = textOf(node);
      const attributeValue = node.getAttribute?.("content") || node.getAttribute?.("data-price") || node.getAttribute?.("data-sale-price") || "";
      const values = moneyValues(`${attributeValue} ${context}`);
      for (const value of values) {
        let score = 10;
        const marker = `${node.getAttribute?.("class") || ""} ${node.getAttribute?.("itemprop") || ""} ${context}`;
        if (/(상품금액|주문금액|합계|총액|amount|total|sum)/i.test(marker)) score += 45;
        if (/(판매가|단가|개당|unit|sale.?price)/i.test(marker)) score += 35;
        if (node.hasAttribute?.("data-price") || node.hasAttribute?.("content")) score += 20;
        priceCandidates.push({ value, score, marker });
      }
    }
    if (!priceCandidates.length) moneyValues(rowText).forEach((value, index) => priceCandidates.push({ value, score: index, marker: rowText }));
    const uniquePrices = [...new Map(priceCandidates.map((candidate) => [`${candidate.value}|${candidate.marker}`, candidate])).values()];
    const explicitUnit = uniquePrices.filter((candidate) => /(판매가|단가|개당|unit|sale.?price)/i.test(candidate.marker)).sort((a, b) => b.score - a.score)[0];
    const explicitTotal = uniquePrices.filter((candidate) => /(상품금액|주문금액|합계|총액|amount|total|sum)/i.test(candidate.marker)).sort((a, b) => b.score - a.score)[0];
    let unitPrice = explicitUnit?.value ?? 0;
    let amount = explicitTotal?.value ?? 0;

    if ((!unitPrice || !amount) && quantity > 1) {
      const values = [...new Set(uniquePrices.map((candidate) => candidate.value))];
      const pair = values.flatMap((unit) => values.map((total) => ({ unit, total }))).find(({ unit, total }) => unit * quantity === total);
      if (pair) { unitPrice ||= pair.unit; amount ||= pair.total; }
    }
    if (!unitPrice && amount && amount % quantity === 0) unitPrice = amount / quantity;
    if (!amount && unitPrice) amount = unitPrice * quantity;
    if (!unitPrice && !amount && uniquePrices.length) {
      const best = [...uniquePrices].sort((a, b) => b.score - a.score)[0];
      if (quantity === 1) { unitPrice = best.value; amount = best.value; }
      else { unitPrice = best.value; amount = best.value * quantity; warnings.push("V11"); }
    }
    if (!unitPrice || !amount) warnings.push("V05");
    if (unitPrice && amount !== quantity * unitPrice) warnings.push("V06");
    if (uniquePrices.length > 2 && !explicitUnit && !explicitTotal && !warnings.includes("V11")) warnings.push("V11");

    const option = [...row.querySelectorAll("[class*='option'], [class*='spec'], [data-testid*='option']")]
      .map((node) => textOf(node)).find((value) => value && value !== name.value && value.length <= 120) ?? "";
    const unitMatch = rowText.match(/(?:단위)\s*[:：]?\s*(개|세트|팩|박스|권|매|병|봉|묶음|식)/);
    const completed = /(주문취소|취소완료|반품완료|교환완료|환불완료)/.test(rowText);
    const controls = /(취소가능|취소불가|교환\/반품 신청|반품안내)/.test(rowText);

    return [{
      내용: name.value, 규격: option, 단위: unitMatch?.[1] ?? "개", 수량: quantity,
      단가: Math.round(unitPrice), 금액: Math.round(amount), _rawName: name.value,
      _rawRow: rowText, _warnings: [...new Set(warnings)],
      excluded: completed && !controls, excludeReason: completed && !controls ? "취소·반품 상태" : undefined,
    }];
  });

  if (!items.length) return { error: "[V-P01] 상품 카드 구조를 확인하지 못했습니다. 쇼핑몰 견적서 파일 또는 캡처를 이용해 주세요." };
  const bodyText = textOf(doc.body);
  const totalPatterns = [
    /(?:총\s*결제\s*금액|결제\s*총액|최종\s*결제\s*금액|총\s*주문\s*금액|결제\s*예정\s*금액)\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*원/,
    /(?:합계)\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*원/,
  ];
  const totalMatch = totalPatterns.map((pattern) => bodyText.match(pattern)).find(Boolean);
  const paidTotal = totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : items.filter((item) => !item.excluded).reduce((sum, item) => sum + item.금액, 0);
  const orderMatch = bodyText.match(/(?:주문번호|주문\s*번호|order\s*(?:no|number))\s*[:：#]?\s*([A-Za-z0-9-]{6,})/i);
  return {
    mall: new URL(sourceUrl).hostname.replace(/^www\./, ""), sourceUrl, orderNo: orderMatch?.[1],
    capturedAt: new Date().toISOString(), paidTotal, _warnings: totalMatch ? [] : ["V08"],
    _extractedBy: "structured-page", items,
  };
}

export async function analyzePublicShoppingLink(value) {
  const sourceUrl = normalizeShoppingUrl(value);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(sourceUrl, { credentials: "omit", redirect: "follow", signal: controller.signal, headers: { Accept: "text/html,application/xhtml+xml" } });
    if (!response.ok) throw new Error(`쇼핑몰 응답 오류 (${response.status})`);
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error("웹 주문 화면 형식이 아닙니다.");
    const html = await response.text();
    if (html.length > 3_000_000) throw new Error("주문 화면이 너무 커서 직접 분석할 수 없습니다.");
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script,style,noscript,nav,footer,svg").forEach((node) => node.remove());
    const order = extractStructuredOrder(document, response.url || sourceUrl, false);
    if (order.error) throw new Error(order.error);
    order._extractedBy = "public-link";
    return order;
  } catch (error) {
    if (error instanceof Error && /V-P0/.test(error.message)) throw error;
    throw new Error("로그인이 필요하거나 쇼핑몰이 외부 읽기를 막고 있습니다.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export function createBookmarklet(appOrigin) {
  const target = JSON.stringify(`${appOrigin.replace(/\/$/, "")}/#quote-import=`);
  const extractor = `(${extractStructuredOrder.toString()})(document,location.href,true)`;
  return `javascript:(()=>{try{const o=${extractor};if(o.error){alert(o.error);return}const b=new TextEncoder().encode(JSON.stringify({order:o}));let s="";for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode.apply(null,b.subarray(i,i+32768));open(${target}+btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""),"_blank")}catch(e){alert("상품 구조를 정확히 읽지 못했습니다. 쇼핑몰 견적서 파일이나 캡처를 이용해 주세요.")}})()`;
}

export function decodeBookmarkletCapture(hash) {
  const prefix = "#quote-import=";
  if (!hash.startsWith(prefix)) return null;
  const encoded = hash.slice(prefix.length).replace(/-/g, "+").replace(/_/g, "/");
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  if (payload?.order && Array.isArray(payload.order.items)) return payload.order;
  if (typeof payload?.text === "string" && typeof payload?.sourceUrl === "string") {
    return parseOrderText(payload.text, { sourceUrl: normalizeShoppingUrl(payload.sourceUrl) });
  }
  throw new Error("북마크에서 전달된 주문 형식이 올바르지 않습니다.");
}
