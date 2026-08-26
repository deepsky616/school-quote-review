(() => {
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const number = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
    const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const moneyMatches = (text) => [...text.matchAll(/(?:₩\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원/g)]
    .map((match) => Number(match[1].replaceAll(",", "")))
    .filter(Number.isFinite);
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const normalizedKey = (value) => String(value).replace(/[^a-zA-Z0-9가-힣]/g, "").toLowerCase();
  const keyPatterns = {
    name: [/^(goods|good|product|prd|item)?(name|title|nm)$/i, /^(상품명|품명|제품명)$/],
    option: [/^(item)?(option|variant|spec)(name|title|value|nm)?$/i, /^(옵션|규격|선택)$/],
    quantity: [/^(qty|quantity|orderqty|orderquantity|count|cnt|ea)$/i, /^(수량|개수)$/],
    unitPrice: [/^(final|sale|sell|discount|discounted|order|unit|item)?(price|cost)$/i, /^(판매가|할인가|단가|예상단가)$/],
    amount: [/^(total|itemtotal|linetotal|order|payment)?(amount|amt|price)$/i, /^(합계|금액|예상금액|결제금액)$/],
    url: [/^(product|goods|item)?(url|link)$/i],
  };

  const fields = (object, depth = 0, prefix = "") => {
    if (!object || typeof object !== "object" || depth > 2) return [];
    return Object.entries(object).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) return fields(value, depth + 1, path);
      return [{ key: normalizedKey(key), path, value }];
    });
  };
  const pick = (list, patterns) => list.find((field) => patterns.some((pattern) => pattern.test(field.key)))?.value;
  const normalizeStructuredItem = (raw, sourceDetail) => {
    const list = fields(raw);
    const name = clean(pick(list, keyPatterns.name));
    if (!name || /^(배송비|쿠폰|할인|적립금|포인트)$/i.test(name)) return null;
    const quantity = clamp(number(pick(list, keyPatterns.quantity)) || 1, 1, 9999);
    const suppliedAmount = number(pick(list, keyPatterns.amount));
    const suppliedUnitPrice = number(pick(list, keyPatterns.unitPrice));
    const unitPrice = suppliedUnitPrice || (suppliedAmount ? Math.round(suppliedAmount / quantity) : 0);
    const amount = suppliedAmount || quantity * unitPrice;
    if (!unitPrice && !amount) return null;
    const option = clean(pick(list, keyPatterns.option));
    const sourceUrl = clean(pick(list, keyPatterns.url));
    const confidence = clamp(0.86 + (quantity > 1 ? 0.03 : 0) + (suppliedUnitPrice ? 0.04 : 0) + (suppliedAmount ? 0.04 : 0), 0, 0.98);
    return {
      내용: name,
      규격: option,
      단위: /도서|book/i.test(sourceDetail) ? "권" : "개",
      수량: quantity,
      단가: unitPrice,
      금액: amount,
      _rawName: option ? `${name} · ${option}` : name,
      _source: "L2",
      _sourceDetail: sourceDetail,
      _confidence: confidence,
      sourceUrl: /^https?:\/\//.test(sourceUrl) ? sourceUrl : undefined,
      excluded: false,
      _warnings: amount !== quantity * unitPrice ? ["V06"] : [],
    };
  };

  const looksLikeItems = (array) => {
    if (!Array.isArray(array) || array.length < 1 || array.length > 500) return false;
    const sample = array.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    if (!sample) return false;
    const list = fields(sample);
    return Boolean(pick(list, keyPatterns.name)) && Boolean(pick(list, keyPatterns.unitPrice) ?? pick(list, keyPatterns.amount));
  };
  const huntArrays = (root, label, maxNodes = 20000) => {
    const hits = [];
    const seen = new WeakSet();
    let visited = 0;
    const walk = (node, path, depth) => {
      if (visited++ > maxNodes || depth > 9 || !node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (looksLikeItems(node)) {
        const items = node.map((entry) => normalizeStructuredItem(entry, `${label}${path}`)).filter(Boolean);
        if (items.length) hits.push({ path: `${label}${path}`, items });
        return;
      }
      if (Array.isArray(node)) node.slice(0, 80).forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
      else Object.entries(node).slice(0, 100).forEach(([key, value]) => walk(value, `${path}.${key}`, depth + 1));
    };
    try { walk(root, "", 0); } catch { /* 접근할 수 없는 getter와 순환 객체는 건너뜁니다. */ }
    return hits;
  };

  const structuredCandidates = [];
  const addStructured = (root, label) => {
    if (!root) return;
    structuredCandidates.push(...huntArrays(root, label));
  };
  addStructured(window.dataLayer, "dataLayer");
  for (const key of ["__NEXT_DATA__", "__NUXT__", "__PRELOADED_STATE__", "__INITIAL_STATE__", "__APOLLO_STATE__", "__remixContext", "INITIAL_STATE", "PAGE_DATA"]) {
    try { addStructured(window[key], `window.${key}`); } catch { /* 페이지가 접근을 막으면 다음 후보를 확인합니다. */ }
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { addStructured(JSON.parse(script.textContent ?? ""), "JSON-LD"); } catch { /* 잘못된 JSON-LD는 무시합니다. */ }
  }

  const uniqueItems = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.내용}|${item.규격}|${item.수량}|${item.단가}|${item.금액}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const bodyText = clean(document.body?.innerText);
  const totalPatterns = [
    /(?:총\s*결제\s*금액|결제\s*총액|최종\s*결제\s*금액|총\s*주문\s*금액)\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*원/,
    /(?:합계)\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*원/,
  ];
  const totalMatch = totalPatterns.map((pattern) => bodyText.match(pattern)).find(Boolean);
  const documentedTotal = totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : 0;
  const orderMatch = bodyText.match(/(?:주문번호|주문\s*번호|order\s*(?:no|number))\s*[:：#]?\s*([A-Za-z0-9-]{6,})/i);
  const apiCandidates = [...new Set(performance.getEntriesByType("resource")
    .filter((entry) => entry.initiatorType === "xmlhttprequest" || entry.initiatorType === "fetch")
    .map((entry) => entry.name)
    .filter((url) => /cart|basket|order|purchase|checkout/i.test(url))
    .map((url) => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return ""; } })
    .filter(Boolean))].slice(0, 12);
  const stage = /cart|basket|장바구니/i.test(`${location.pathname} ${document.title}`) ? "pre-purchase" : "post-purchase";

  const bestStructured = structuredCandidates
    .map((candidate) => ({ ...candidate, items: uniqueItems(candidate.items) }))
    .sort((left, right) => (right.items.length * 10 + right.items.reduce((sum, item) => sum + item._confidence, 0)) - (left.items.length * 10 + left.items.reduce((sum, item) => sum + item._confidence, 0)))[0];
  if (bestStructured?.items.length) {
    const calculatedTotal = bestStructured.items.reduce((sum, item) => sum + item.금액, 0);
    const confidence = bestStructured.items.reduce((sum, item) => sum + item._confidence, 0) / bestStructured.items.length;
    return {
      mall: location.hostname.replace(/^www\./, ""), capturedAt: new Date().toISOString(), sourceUrl: location.href,
      orderNo: orderMatch?.[1], stage, paidTotal: documentedTotal || calculatedTotal,
      _warnings: documentedTotal && documentedTotal !== calculatedTotal ? ["V07"] : [],
      _extractedBy: "structured-page-data", _source: "L2", _sourceDetail: bestStructured.path,
      _confidence: documentedTotal && documentedTotal !== calculatedTotal ? Math.min(confidence, 0.84) : confidence,
      _diagnostics: { apiCandidates, structuredCandidateCount: structuredCandidates.length }, items: bestStructured.items,
    };
  }

  const selectors = [
    "[data-testid*='order-item']", "[data-testid*='product-item']", "[class*='order-item']",
    "[class*='orderItem']", "[class*='product-item']", "[class*='productItem']",
    "li[class*='order']", "li[class*='product']", "table tbody tr",
  ];
  let candidates = [];
  for (const selector of selectors) {
    const matches = [...document.querySelectorAll(selector)].filter((element) => {
      const text = clean(element.innerText);
      return isVisible(element) && text.length >= 8 && text.length <= 1200 && moneyMatches(text).length > 0;
    });
    const leafRows = matches.filter((element) => !matches.some((other) => other !== element && element.contains(other)));
    if (leafRows.length >= 1) { candidates = leafRows; break; }
  }
  if (!candidates.length) return { error: "[V-P01] 주문 품목을 찾지 못했습니다. 복사·붙여넣기 또는 PDF 문서를 사용해 주세요." };

  const seenRows = new Set();
  const items = candidates.flatMap((element) => {
    const rawRow = clean(element.innerText);
    if (seenRows.has(rawRow)) return [];
    seenRows.add(rawRow);
    const nameCandidates = [...element.querySelectorAll("[data-testid*='name'], [class*='name'], [class*='title'], h2, h3, h4, strong, a")]
      .map((node) => clean(node.textContent))
      .filter((text) => text.length >= 2 && text.length <= 120 && !/^\d[\d,]*\s*원$/.test(text) && !/(주문취소|취소완료|반품완료|교환완료|환불완료|배송조회|리뷰)/.test(text));
    const fallbackName = rawRow.split(/\s{2,}|\n/).map(clean).find((text) => text.length >= 2 && !/\d[\d,]*\s*원/.test(text));
    const rawName = nameCandidates.sort((left, right) => right.length - left.length)[0] ?? fallbackName ?? "";
    const quantityMatch = rawRow.match(/(?:수량|qty|quantity)\s*[:：]?\s*(\d+)/i)
      ?? rawRow.match(/(?<![가-힣A-Za-z0-9_])(\d+)\s*(?:개|박스|세트|묶음|권)(?![가-힣A-Za-z0-9_])/);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;
    const amounts = moneyMatches(rawRow);
    const amount = amounts.at(-1) ?? 0;
    const unitPrice = quantity > 0 ? Math.round(amount / quantity) : 0;
    const confidence = rawName && amount ? 0.78 : 0.42;
    return [{
      내용: rawName, 규격: "", 단위: "개", 수량: quantity, 단가: unitPrice, 금액: amount,
      _rawName: rawName, _rawRow: rawRow, _source: "L3", _sourceDetail: "DOM 반복 구조", _confidence: confidence,
      excluded: false, _warnings: amount !== quantity * unitPrice ? ["V06"] : [],
    }];
  });
  if (!items.length || items.every((item) => !item.내용 && !item.금액)) {
    return { error: "[V-P02] 품목 행은 찾았지만 값이 비어 있습니다. 복사·붙여넣기 또는 PDF 문서를 사용해 주세요." };
  }
  const calculatedTotal = items.reduce((sum, item) => sum + item.금액, 0);
  const confidence = items.reduce((sum, item) => sum + item._confidence, 0) / items.length;
  return {
    mall: location.hostname.replace(/^www\./, ""), capturedAt: new Date().toISOString(), sourceUrl: location.href,
    orderNo: orderMatch?.[1], stage, paidTotal: documentedTotal || calculatedTotal,
    _warnings: documentedTotal && documentedTotal !== calculatedTotal ? ["V07"] : [],
    _extractedBy: "browser-dom", _source: "L3", _sourceDetail: "DOM 반복 구조",
    _confidence: documentedTotal && documentedTotal !== calculatedTotal ? Math.min(confidence, 0.62) : confidence,
    _diagnostics: { apiCandidates, structuredCandidateCount: structuredCandidates.length }, items,
  };
})();
