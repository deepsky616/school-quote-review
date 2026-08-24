(() => {
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const moneyMatches = (text) => [...text.matchAll(/(?:₩\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원/g)]
    .map((match) => Number(match[1].replaceAll(",", "")))
    .filter(Number.isFinite);
  const selectors = [
    "[data-testid*='order-item']",
    "[data-testid*='product-item']",
    "[class*='order-item']",
    "[class*='orderItem']",
    "[class*='product-item']",
    "[class*='productItem']",
    "li[class*='order']",
    "li[class*='product']",
    "table tbody tr"
  ];

  let candidates = [];
  for (const selector of selectors) {
    const matches = [...document.querySelectorAll(selector)].filter((element) => {
      const text = clean(element.innerText);
      return isVisible(element) && text.length >= 8 && text.length <= 1200 && moneyMatches(text).length > 0;
    });
    const leafRows = matches.filter((element) => !matches.some((other) => other !== element && element.contains(other)));
    if (leafRows.length >= 2) {
      candidates = leafRows;
      break;
    }
  }

  if (candidates.length < 2) {
    return {
      error: "[V-P01] 주문 품목을 2행 이상 찾지 못했습니다. JSON·CSV 불러오기 또는 직접 입력을 사용해 주세요."
    };
  }

  const uniqueRows = [];
  const seen = new Set();
  for (const element of candidates) {
    const text = clean(element.innerText);
    if (!seen.has(text)) {
      seen.add(text);
      uniqueRows.push(element);
    }
  }

  const items = uniqueRows.map((element) => {
    const rawRow = clean(element.innerText);
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
    return {
      내용: rawName,
      규격: "",
      단위: "개",
      수량: quantity,
      단가: unitPrice,
      금액: amount,
      _rawName: rawName,
      _rawRow: rawRow,
      excluded: false,
      confidence: rawName && amount ? 0.82 : 0.45
    };
  });

  if (items.every((item) => !item.내용 && !item.금액)) {
    return { error: "[V-P02] 품목 행은 찾았지만 값이 모두 비어 있습니다. 쇼핑몰 화면 구조가 변경되었을 수 있습니다." };
  }

  const bodyText = clean(document.body.innerText);
  const totalPatterns = [
    /(?:총\s*결제\s*금액|결제\s*총액|최종\s*결제\s*금액|총\s*주문\s*금액)\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*원/,
    /(?:합계)\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*원/
  ];
  const totalMatch = totalPatterns.map((pattern) => bodyText.match(pattern)).find(Boolean);
  const paidTotal = totalMatch
    ? Number(totalMatch[1].replaceAll(",", ""))
    : items.reduce((sum, item) => sum + item.금액, 0);
  const orderMatch = bodyText.match(/(?:주문번호|주문\s*번호|order\s*(?:no|number))\s*[:：#]?\s*([A-Za-z0-9-]{6,})/i);

  return {
    mall: location.hostname.replace(/^www\./, ""),
    capturedAt: new Date().toISOString(),
    sourceUrl: location.href,
    orderNo: orderMatch?.[1],
    paidTotal,
    _extractedBy: "browser-helper",
    items
  };
})();
