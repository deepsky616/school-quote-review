const TOTAL_LABEL = /(총\s*결제|최종\s*결제|결제\s*(?:예정\s*)?금액|주문\s*금액|총\s*상품\s*금액|총액|합계)/i;
const HEADER_LABEL = /^(상품|상품명|품명|내용|옵션|규격|수량|단가|금액|결제금액|주문금액)$/i;
const CONTROL_LABEL = /^(장바구니|주문내역|주문상세|배송조회|리뷰쓰기|교환|반품|취소|문의|구매확정|다시 구매|닫기|확인)$/i;
const FOREIGN_CURRENCY = /(?:US?D|JPY|EUR|CNY|[$€¥])/i;
const MARKDOWN_LINK = /^\s*(?:[-*]\s*)?\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*$/i;
const SITE_HEADER = /^(?:아이스크림몰|쿠팡|G마켓|YES24|11번가)(?:\s|$).*https?:\/\//i;
const OPTION_LINE = /^(?:선택|색상|옵션)\s*[:：]?/i;
const QUANTITY_UNITS = "개|세트|팩|박스|권|매|병|봉|묶음|식";

const toNumber = (value = "") => {
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

const moneyValues = (line) => {
  const matches = line.match(/(?:₩\s*\d[\d,]*|\d[\d,]*\s*원|\d{1,3}(?:,\d{3})+)/g) ?? [];
  return matches.map(toNumber).filter((value) => value >= 0);
};

const cleanScrapedLine = (value) => String(value ?? "")
  .replace(/(?:&#x0*20;|&#0*32;|&nbsp;)/gi, " ")
  .replace(/(?:&#x0*C6D0;|&#0*50896;)/gi, "원")
  .replace(/\*\*/g, "")
  .replace(/^\\\s*$/, "")
  .replace(/\\_/g, "_")
  .replace(/\s+/g, " ")
  .trim();

const cleanScrapedUrl = (value) => String(value ?? "")
  .replace(/\\([&?#])/g, "$1")
  .trim();

const isNonProductLine = (value) => {
  const line = cleanScrapedLine(value);
  if (!line || SITE_HEADER.test(line) || HEADER_LABEL.test(line) || CONTROL_LABEL.test(line)) return true;
  if (/^[\d.,%+\s]+$/.test(line)) return true;
  if (/^(?:상품\s*금액|쿠폰\s*(?:적용|할인)|할인\s*\d|무료배송|배송비|로켓배송\s*상품|합배송\s*상품|삭제|내일\b|품절임박|만족했어요|한달구매|판매자(?:로켓)?|도착|주문\s*가능)/i.test(line)) return true;
  if (/(?:캐시|포인트)\s*적립|YES포인트|이상\s*(?:구매\s*시\s*)?(?:배송비\s*)?무료|\d+\s*%\s*$|\d+\s*개당/i.test(line)) return true;
  return TOTAL_LABEL.test(line);
};

const makeItem = ({ name, spec = "", unit = "개", quantity = 1, amount, sourceUrl, raw, warnings = [] }) => {
  const safeQuantity = Math.max(1, Math.round(quantity));
  const unitPrice = Math.round(amount / safeQuantity);
  const itemWarnings = [...warnings];
  if (amount !== safeQuantity * unitPrice && !itemWarnings.includes("V06")) itemWarnings.push("V06");
  return {
    내용: name,
    규격: spec,
    단위: unit,
    수량: safeQuantity,
    단가: unitPrice,
    금액: amount,
    _rawName: raw,
    _warnings: itemWarnings,
    ...(sourceUrl ? { sourceUrl } : {}),
    excluded: false,
  };
};

const shippingItemFromLine = (line, sourceUrl) => {
  if (!/배송비/i.test(line)) return null;
  const cleaned = cleanScrapedLine(line);
  const outcomes = [...cleaned.matchAll(/무료\s*배송|[\d,]+\s*원/gi)];
  const rightmostOutcome = outcomes.at(-1)?.[0] ?? "";
  if (/무료\s*배송/i.test(rightmostOutcome)) return null;
  const shippingPrice = toNumber(rightmostOutcome);
  if (!shippingPrice) return null;
  return makeItem({
    name: "배송비",
    spec: "",
    unit: "건",
    quantity: 1,
    amount: shippingPrice,
    sourceUrl,
    raw: cleaned,
  });
};

function scrapedProductBlocks(text) {
  const blocks = [];
  let current = null;
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = cleanScrapedLine(rawLine);
    const header = line.match(MARKDOWN_LINK);
    if (header) {
      current = { name: header[1].trim(), sourceUrl: cleanScrapedUrl(header[2]), lines: [] };
      blocks.push(current);
      continue;
    }
    if (/^-{3,}$/.test(line)) { current = null; continue; }
    if (current && line) current.lines.push(line);
  }
  return blocks;
}

function scrapedProductItems(text) {
  return scrapedProductBlocks(text).flatMap((block) => {
    const quantityIndex = block.lines.findIndex((line) => /^수량\s*[:：]?\s*\d+/i.test(line));
    const quantityLine = quantityIndex >= 0 ? block.lines[quantityIndex] : "";
    const quantityMatch = quantityLine.match(/^수량\s*[:：]?\s*(\d{1,4})\s*(개|세트|팩|박스|권|매|병|봉|묶음|식)?/i);
    const priceLine = block.lines.find((line) => /상품\s*금액\s*[:：]?/i.test(line));
    const prices = moneyValues(priceLine ?? "");
    if (!quantityMatch || !prices.length) return [];

    const quantity = Math.max(1, toNumber(quantityMatch[1]));
    const unit = quantityMatch[2] || "개";
    const amount = prices[prices.length - 1];
    const spec = block.lines.slice(0, quantityIndex)
      .filter((line) => !/^(?:쿠폰\s*적용|배송|판매자|주문|결제)/i.test(line))
      .map((line) => line.replace(/^(선택|색상|옵션)(?=\S)/, "$1 "))
      .join(" · ");
    const item = makeItem({
      name: block.name,
      spec,
      unit,
      quantity,
      amount,
      sourceUrl: block.sourceUrl,
      raw: `${block.name} ${priceLine}`,
    });

    const shippingLine = block.lines.find((line) => /배송비/i.test(line) && moneyValues(line).length > 0);
    const shippingItem = shippingItemFromLine(shippingLine ?? "", block.sourceUrl);
    return shippingItem ? [item, shippingItem] : [item];
  });
}

const cleanElevenStreetLine = (value) => cleanScrapedLine(value)
  .replace(/^[-*]\s*/, "")
  .replace(/\*+/g, "")
  .trim();

function elevenStreetProductItems(text) {
  if (!/11st\.co\.kr/i.test(String(text ?? ""))) return [];
  return scrapedProductBlocks(text)
    .filter((block) => /11st\.co\.kr/i.test(block.sourceUrl))
    .flatMap((block) => {
      const lines = block.lines.map(cleanElevenStreetLine).filter(Boolean);
      const quantityLine = lines.find((line) => new RegExp(`^\\d{1,4}\\s*(?:${QUANTITY_UNITS})$`, "i").test(line));
      const quantityMatch = quantityLine?.match(new RegExp(`^(\\d{1,4})\\s*(${QUANTITY_UNITS})$`, "i"));
      const discountIndex = lines.findIndex((line) => /^할인\s*모음가/i.test(line));
      const discountPrice = discountIndex >= 0
        ? lines.slice(discountIndex, discountIndex + 3).flatMap(moneyValues).find((value) => value > 0) ?? 0
        : 0;
      if (!quantityMatch || !discountPrice) return [];

      const quantity = Math.max(1, toNumber(quantityMatch[1]));
      const optionLine = lines.find((line) => /^옵션\s*[:：]?/i.test(line));
      const spec = optionLine?.replace(/^옵션\s*[:：]?\s*/i, "").trim() ?? "";
      const item = makeItem({
        name: block.name,
        spec,
        unit: quantityMatch[2] || "개",
        quantity,
        amount: discountPrice * quantity,
        sourceUrl: block.sourceUrl,
        raw: `${block.name} ${lines.join(" ")}`,
      });

      if (lines.some((line) => /무료\s*배송/i.test(line))) return [item];
      const prepaidIndex = lines.findIndex((line) => /^선결제/i.test(line));
      const shippingPrice = prepaidIndex >= 0
        ? lines.slice(prepaidIndex, prepaidIndex + 3).flatMap(moneyValues).find((value) => value > 0) ?? 0
        : 0;
      if (!shippingPrice) return [item];
      const shipping = makeItem({
        name: "배송비",
        spec: "",
        unit: "건",
        quantity: 1,
        amount: shippingPrice,
        sourceUrl: block.sourceUrl,
        raw: lines.slice(prepaidIndex, prepaidIndex + 3).join(" "),
      });
      return [item, shipping];
    });
}

function catalogProductItems(text) {
  const lines = String(text ?? "").split("\n").map(cleanScrapedLine).filter(Boolean);
  const quantityIndexes = lines.flatMap((line, index) => (
    /^단일\s*상품\s*\//i.test(line)
    || new RegExp(`\\/\\s*\\d{1,4}\\s*(?:${QUANTITY_UNITS})$`, "i").test(line)
  ) && moneyValues(lines[index + 1] ?? "").length > 0 ? [index] : []);
  return quantityIndexes.flatMap((quantityIndex) => {
    const quantityLine = lines[quantityIndex];
    const quantityMatch = quantityLine.match(new RegExp(`\\/\\s*(\\d{1,4})\\s*(${QUANTITY_UNITS})?\\s*$`, "i"));
    const priceLine = lines.slice(quantityIndex + 1, quantityIndex + 4)
      .find((line) => moneyValues(line).length > 0 && !/배송|적립|포인트/i.test(line));
    const prices = moneyValues(priceLine ?? "");
    if (!quantityMatch || !prices.length) return [];

    const reversedNameLines = [];
    for (let cursor = quantityIndex - 1; cursor >= 0 && reversedNameLines.length < 3; cursor -= 1) {
      const line = lines[cursor];
      if (/^합배송\s*상품$/i.test(line)) continue;
      if (SITE_HEADER.test(line) || /배송|무료|^단일\s*상품|\d[\d,]*\s*원/.test(line)) break;
      if (isNonProductLine(line)) continue;
      reversedNameLines.push(line);
    }
    const nameLines = reversedNameLines.reverse().slice(-2);
    if (!nameLines.length) return [];

    const [firstName, secondName] = nameLines.length === 1 ? ["", nameLines[0]] : nameLines;
    const name = firstName && !secondName.toLowerCase().startsWith(firstName.toLowerCase())
      ? `${firstName} ${secondName}`
      : secondName;
    const quantity = Math.max(1, toNumber(quantityMatch[1]));
    const amount = prices[prices.length - 1];
    const explicitSpec = quantityLine.replace(/\s*\/\s*\d{1,4}\s*(?:개|세트|팩|박스|권|매|병|봉|묶음|식)?\s*$/i, "").trim();
    return [makeItem({
      name,
      spec: /^단일\s*상품$/i.test(explicitSpec) ? "단일상품" : explicitSpec,
      unit: quantityMatch[2] || "개",
      quantity,
      amount,
      raw: `${name} ${quantityLine} ${priceLine}`,
    })];
  });
}

const sourceUrlFor = (text, hostname) => {
  const urls = String(text ?? "").match(/https?:\/\/[^\s)\]]+/gi) ?? [];
  const found = urls.map(cleanScrapedUrl).find((url) => url.toLowerCase().includes(hostname.toLowerCase()));
  return found;
};

function coupangProductItems(text) {
  const lines = String(text ?? "").split("\n").map(cleanScrapedLine).filter(Boolean);
  const productIndexes = lines.flatMap((line, index) => /옵션\s*[:：]/i.test(line) && !isNonProductLine(line) ? [index] : []);
  if (!productIndexes.length) return [];
  const sourceUrl = sourceUrlFor(text, "coupang.com");

  return productIndexes.flatMap((productIndex, position) => {
    const nextProductIndex = productIndexes[position + 1] ?? lines.length;
    const nextSiteIndex = lines.findIndex((line, index) => index > productIndex && SITE_HEADER.test(line));
    const blockEnd = nextSiteIndex >= 0 ? Math.min(nextProductIndex, nextSiteIndex) : nextProductIndex;
    const block = lines.slice(productIndex, blockEnd);
    const [rawTitle, rawSpec = ""] = lines[productIndex].split(/옵션\s*[:：]\s*/i, 2);
    let name = rawTitle.replace(/^(?:star\s+starred\s*)+/i, "").trim();
    if (!name) {
      for (let cursor = productIndex - 1; cursor >= Math.max(0, productIndex - 3); cursor -= 1) {
        if (!isNonProductLine(lines[cursor]) && !moneyValues(lines[cursor]).length) {
          name = lines[cursor].replace(/^(?:star\s+starred\s*)+/i, "").trim();
          break;
        }
      }
    }

    const priceCandidates = block.flatMap((line) => {
      if (/무료배송|배송비|주문\s*가능|쿠폰할인\s*적용|캐시\s*적립|포인트|\d+\s*개당/i.test(line)) return [];
      return moneyValues(line);
    });
    const amount = priceCandidates[priceCandidates.length - 1] ?? 0;
    if (!name || !amount) return [];

    const perUnitLine = block.find((line) => /\d+\s*개당\s*[\d,]+\s*원/i.test(line));
    const perUnitMatch = perUnitLine?.match(/\d+\s*개당\s*([\d,]+)\s*원/i);
    const perUnitPrice = toNumber(perUnitMatch?.[1]);
    const inferredQuantity = perUnitPrice > 0 && amount % perUnitPrice === 0 ? amount / perUnitPrice : 1;
    const warnings = perUnitPrice > 0 && inferredQuantity === 1 && amount !== perUnitPrice ? ["V11"] : [];
    if (!perUnitPrice) warnings.push("V04");

    const item = makeItem({
      name,
      spec: rawSpec.trim(),
      unit: "개",
      quantity: inferredQuantity,
      amount,
      sourceUrl,
      raw: block.join(" "),
      warnings,
    });
    const shipping = block.map((line) => shippingItemFromLine(line, sourceUrl)).find(Boolean);
    return shipping ? [item, shipping] : [item];
  });
}

function gmarketPlainProductItems(text) {
  const lines = String(text ?? "").split("\n").map(cleanScrapedLine).filter(Boolean);
  if (lines.some((line) => MARKDOWN_LINK.test(line)) || !lines.some((line) => /상품\s*금액/i.test(line))) return [];
  const quantityIndexes = lines.flatMap((line, index) => /^수량\s*[:：]?\s*\d+/i.test(line) ? [index] : []);
  const sourceUrl = sourceUrlFor(text, "gmarket.co.kr");

  return quantityIndexes.flatMap((quantityIndex, position) => {
    const quantityLine = lines[quantityIndex];
    const quantityMatch = quantityLine.match(new RegExp(`^수량\\s*[:：]?\\s*(\\d{1,4})\\s*(${QUANTITY_UNITS})?`, "i"));
    const nextQuantityIndex = quantityIndexes[position + 1] ?? lines.length;
    const nextSiteIndex = lines.findIndex((line, index) => index > quantityIndex && SITE_HEADER.test(line));
    const blockEnd = nextSiteIndex >= 0 ? Math.min(nextQuantityIndex, nextSiteIndex) : nextQuantityIndex;
    const block = lines.slice(quantityIndex, blockEnd);
    const priceIndex = block.findIndex((line) => /상품\s*금액/i.test(line));
    if (!quantityMatch || priceIndex < 0) return [];

    const priceCandidates = [...moneyValues(block[priceIndex])];
    for (let cursor = priceIndex + 1; cursor < block.length; cursor += 1) {
      if (!/^[\d,]+\s*원$/i.test(block[cursor])) break;
      priceCandidates.push(...moneyValues(block[cursor]));
    }
    const amount = priceCandidates[priceCandidates.length - 1] ?? 0;
    if (!amount) return [];

    const reversedNameLines = [];
    for (let cursor = quantityIndex - 1; cursor >= 0 && reversedNameLines.length < 3; cursor -= 1) {
      const line = lines[cursor];
      if (SITE_HEADER.test(line) || /배송비|무료배송|상품\s*금액|^수량\s*[:：]?|^[\d,]+\s*원$/i.test(line)) break;
      if (isNonProductLine(line)) continue;
      reversedNameLines.push(line);
    }
    const candidates = reversedNameLines.reverse();
    const spec = candidates.filter((line) => OPTION_LINE.test(line))
      .map((line) => line.replace(/^(선택|색상|옵션)(?=\S)/i, "$1 "))
      .join(" · ");
    const nameLines = [...new Set(candidates.filter((line) => !OPTION_LINE.test(line)))].slice(-2);
    const name = nameLines.join(" ").trim();
    if (!name) return [];

    const item = makeItem({
      name,
      spec,
      unit: quantityMatch[2] || "개",
      quantity: toNumber(quantityMatch[1]),
      amount,
      sourceUrl,
      raw: `${name} ${quantityLine} ${block.slice(priceIndex, priceIndex + 3).join(" ")}`,
    });
    const shippingLine = block.find((line) => /배송비/i.test(line));
    const shipping = shippingItemFromLine(shippingLine ?? "", sourceUrl);
    return shipping ? [item, shipping] : [item];
  });
}

const cleanBookName = (value) => cleanScrapedLine(value)
  .replace(/^\[도서\]\s*/i, "")
  .replace(/\s*새창\s*/gi, " ")
  .replace(/\s*소득공제\s*$/i, "")
  .replace(/\s+/g, " ")
  .trim();

const makeBookItem = ({ name, quantity, discountPrice, amount, sourceUrl, raw }) => {
  const safeQuantity = Math.max(1, Math.round(quantity));
  const safeAmount = amount || discountPrice * safeQuantity;
  const safeUnitPrice = discountPrice || Math.round(safeAmount / safeQuantity);
  return {
    내용: name,
    규격: "도서",
    단위: "권",
    수량: safeQuantity,
    단가: safeUnitPrice,
    금액: safeAmount,
    _rawName: raw,
    _warnings: safeAmount !== safeQuantity * safeUnitPrice ? ["V06"] : [],
    ...(sourceUrl ? { sourceUrl } : {}),
    excluded: false,
  };
};

function yes24ProductItems(text) {
  const sourceUrl = sourceUrlFor(text, "yes24.com");
  const rawLines = String(text ?? "").replace(/\r/g, "").split("\n");
  const headerIndex = rawLines.findIndex((line) => /상품명/.test(line) && /정가/.test(line) && /수량/.test(line) && /할인금액/.test(line) && /합계/.test(line));
  const tableItems = [];

  if (headerIndex >= 0 && /\t|\|/.test(rawLines[headerIndex])) {
    const separator = /\t|\s*\|\s*/;
    for (const rawLine of rawLines.slice(headerIndex + 1)) {
      let cells = rawLine.split(separator).map(cleanScrapedLine);
      if (cells.length >= 6 && !cells[0]) cells = cells.slice(1);
      if (cells.length < 5 || !/\d/.test(cells[2] ?? "")) continue;
      const name = cleanBookName(cells[0]);
      const quantity = toNumber(cells[2]);
      const discountPrice = moneyValues(cells[3] ?? "")[0] ?? 0;
      const amount = moneyValues(cells[4] ?? "")[0] ?? 0;
      if (!name || !quantity || (!discountPrice && !amount)) continue;
      tableItems.push(makeBookItem({
        name,
        quantity,
        discountPrice,
        amount: amount || discountPrice * quantity,
        sourceUrl,
        raw: rawLine,
      }));
    }
  }
  if (tableItems.length) return tableItems;

  const lines = rawLines.map(cleanScrapedLine).filter(Boolean);
  const bookIndexes = lines.flatMap((line, index) => /^\[도서\]/i.test(line) ? [index] : []);
  return bookIndexes.flatMap((bookIndex, position) => {
    const block = lines.slice(bookIndex, bookIndexes[position + 1] ?? lines.length);
    const detailCells = block.slice(1).flatMap((line) => {
      const combinedPriceRow = line.match(/^([\d,]+\s*원)\s+(\d{1,4})\s+([\d,]+\s*원)(?:\s|$)/);
      if (combinedPriceRow) return combinedPriceRow.slice(1);
      return line.split(/\t|\s*\|\s*/).map(cleanScrapedLine).filter(Boolean);
    });
    const regularPriceIndex = detailCells.findIndex((cell, index) => (
      moneyValues(cell).length > 0
      && /^\d{1,4}$/.test(detailCells[index + 1] ?? "")
      && moneyValues(detailCells[index + 2] ?? "").length > 0
    ));
    const name = cleanBookName(block[0]);

    if (regularPriceIndex >= 0) {
      const quantity = toNumber(detailCells[regularPriceIndex + 1]);
      const discountPrice = moneyValues(detailCells[regularPriceIndex + 2])[0] ?? 0;
      const totalCandidates = detailCells.slice(regularPriceIndex + 3)
        .filter((cell) => !/(?:YES\s*)?포인트|적립|배송|도착|출고/i.test(cell))
        .flatMap((cell) => moneyValues(cell));
      const amount = totalCandidates.at(-1) ?? discountPrice * quantity;
      if (!name || !quantity || !discountPrice || !amount) return [];
      return [makeBookItem({
        name,
        quantity,
        discountPrice,
        amount,
        sourceUrl,
        raw: block.join(" "),
      })];
    }

    const quantityIndex = block.findIndex((line, index) => index > 0 && /^\d{1,4}$/.test(line));
    if (quantityIndex < 0) return [];
    const quantity = toNumber(block[quantityIndex]);
    const amountLines = block.slice(quantityIndex + 1).filter((line) => moneyValues(line).length > 0 && !/배송|포인트/i.test(line));
    const discountPrice = amountLines.find((line) => /할인/i.test(line));
    const totalLine = amountLines.find((line) => !/할인/i.test(line));
    const unitPrice = moneyValues(discountPrice ?? "")[0] ?? 0;
    const amount = moneyValues(totalLine ?? "")[0] ?? unitPrice * quantity;
    if (!name || !amount) return [];
    return [makeBookItem({ name, quantity, discountPrice: unitPrice, amount, sourceUrl, raw: block.join(" ") })];
  });
}

const cleanName = (value) => value
  .replace(/(?:₩\s*\d[\d,]*|\d[\d,]*\s*원|\d{1,3}(?:,\d{3})+)/g, " ")
  .replace(/(?:판매가|상품금액|주문금액|금액|가격|단가)\s*[:：]?/gi, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 160);

const isNameCandidate = (line) => {
  const value = cleanName(line);
  if (value.length < 2 || isNonProductLine(value)) return false;
  if (/^(옵션|규격|수량|배송|무료배송|도착|판매자|주문번호|결제|쿠폰|할인|포인트|캐시)\b/i.test(value)) return false;
  return !TOTAL_LABEL.test(value);
};

const quantityFrom = (line) => {
  const explicit = line.match(/(?:수량\s*[:：]?\s*|[x×]\s*)(\d{1,4})/i);
  if (explicit) return { value: Math.max(1, toNumber(explicit[1])), explicit: true };
  const suffix = line.match(/(?:^|\s)(\d{1,4})\s*(?:개|세트|팩|박스|권|매|병|봉|묶음)(?:\s|$)/);
  return suffix
    ? { value: Math.max(1, toNumber(suffix[1])), explicit: true }
    : { value: 1, explicit: false };
};

function structuredItem(line) {
  if (!/[\t|]/.test(line)) return null;
  const cells = line.split(/\t|\s*\|\s*/).map((cell) => cell.trim()).filter(Boolean);
  if (cells.length < 3 || HEADER_LABEL.test(cells[0])) return null;
  const nameIndex = /^\d{1,3}$/.test(cells[0]) && cells.length >= 5 ? 1 : 0;

  const numericCells = cells.map((cell, index) => ({ index, value: toNumber(cell), raw: cell }))
    .filter(({ index, raw, value }) => index > nameIndex && value > 0 && (/\d/.test(raw)));
  if (numericCells.length < 2) return null;

  const priceCell = numericCells[numericCells.length - 1];
  const qtyCell = [...numericCells].reverse().find((cell) => cell.index < priceCell.index && cell.value <= 1000);
  if (!qtyCell) return null;

  const qty = qtyCell.value;
  const suppliedPrice = priceCell.value;
  const hasExplicitAmount = numericCells.length >= 3;
  const amount = hasExplicitAmount ? suppliedPrice : qty * suppliedPrice;
  const unitPrice = hasExplicitAmount ? Math.round(amount / qty) : suppliedPrice;
  const name = cleanName(cells[nameIndex]);
  if (!name) return null;
  const unit = cells.slice(nameIndex + 1, qtyCell.index).find((cell) => /^(개|세트|팩|박스|권|매|병|봉|묶음|식)$/i.test(cell)) ?? "개";

  return {
    내용: name,
    규격: cells.slice(nameIndex + 1, qtyCell.index).filter((cell) => cell !== unit).join(" · "),
    단위: unit,
    수량: qty,
    단가: unitPrice,
    금액: amount,
    _rawName: line,
    _warnings: amount !== qty * unitPrice ? ["V06"] : [],
    excluded: false,
  };
}

function textItem(lines, index) {
  const line = lines[index];
  const prices = moneyValues(line);
  if (!prices.length || TOTAL_LABEL.test(line)) return null;

  const amount = prices[prices.length - 1];
  if (amount <= 0) return null;
  if (/배송비/i.test(line)) {
    return shippingItemFromLine(line);
  }
  if (isNonProductLine(line)) return null;
  const quantity = quantityFrom(line);
  const qty = quantity.value;
  let name = cleanName(line);
  let inferredName = false;

  if (!isNameCandidate(name)) {
    name = "";
    for (let cursor = index - 1; cursor >= Math.max(0, index - 4); cursor -= 1) {
      if (isNameCandidate(lines[cursor]) && moneyValues(lines[cursor]).length === 0) {
        name = cleanName(lines[cursor]);
        inferredName = true;
        break;
      }
    }
  }

  if (!name) return null;
  const explicitlyUnitPrice = /(?:판매가|단가|개당)\s*[:：]?/i.test(line);
  const explicitlyTotalPrice = /(?:상품금액|주문금액|합계|총액|금액)\s*[:：]?/i.test(line);
  const unitPrice = explicitlyUnitPrice ? amount : Math.round(amount / qty);
  const calculatedAmount = explicitlyUnitPrice ? amount * qty : amount;
  const warnings = [];
  if (inferredName || name.length < 4) warnings.push("V03");
  if (!quantity.explicit) warnings.push("V04");
  if (qty > 1 && !explicitlyUnitPrice && !explicitlyTotalPrice) warnings.push("V11");
  if (calculatedAmount !== qty * unitPrice) warnings.push("V06");
  if (FOREIGN_CURRENCY.test(line)) warnings.push("V12");

  return {
    내용: name,
    규격: "",
    단위: "개",
    수량: qty,
    단가: unitPrice,
    금액: calculatedAmount,
    _rawName: line,
    _warnings: warnings,
    excluded: false,
  };
}

function findPaidTotal(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!TOTAL_LABEL.test(lines[index])) continue;
    const values = moneyValues(lines[index]);
    if (values.length) return values[values.length - 1];
    const nextValues = moneyValues(lines[index + 1] ?? "");
    if (nextValues.length) return nextValues[nextValues.length - 1];
  }
  return 0;
}

function findOrderNo(lines) {
  const combined = lines.join(" ");
  const match = combined.match(/(?:주문\s*번호|order\s*(?:no|number))\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{5,})/i);
  return match?.[1] ?? "주문번호 확인 필요";
}

function mallFromUrl(sourceUrl) {
  if (!sourceUrl) return "붙여넣은 주문";
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return "붙여넣은 주문";
  }
}

export function parseOrderText(text, options = {}) {
  const normalized = String(text ?? "").replace(/\u00a0/g, " ").replace(/\r/g, "").trim();
  if (normalized.length < 12) throw new Error("[V-P02] 복사한 주문 내용이 너무 짧습니다.");

  const lines = normalized.split("\n").map((line) => line
    .split("\t")
    .map((cell) => cell.replace(/ +/g, " ").trim())
    .join("\t")
    .trim()).filter(Boolean);
  const scraped = scrapedProductItems(normalized);
  const catalog = catalogProductItems(normalized);
  const coupang = coupangProductItems(normalized);
  const gmarketPlain = scraped.length ? [] : gmarketPlainProductItems(normalized);
  const yes24 = yes24ProductItems(normalized);
  const elevenStreet = elevenStreetProductItems(normalized);
  const specialized = elevenStreet.length
    ? elevenStreet
    : [...scraped, ...catalog, ...coupang, ...gmarketPlain, ...yes24];
  const structured = lines.map(structuredItem).filter(Boolean);
  const candidates = specialized.length
    ? specialized
    : structured.length
    ? structured
    : lines.map((_, index) => textItem(lines, index)).filter(Boolean);

  const seen = new Set();
  const items = candidates.filter((item) => {
    const key = `${item.내용}|${item.수량}|${item.금액}|${item.sourceUrl ?? ""}|${item._rawName ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);

  if (!items.length) {
    throw new Error("[V-P02] 품명과 금액을 찾지 못했습니다. JSON·CSV 또는 직접 입력을 이용해 주세요.");
  }

  const suppliedTotal = toNumber(options.paidTotal);
  const extractedTotal = findPaidTotal(lines);
  const calculatedTotal = items.reduce((sum, item) => sum + item.금액, 0);
  const paidTotal = suppliedTotal || extractedTotal || calculatedTotal;
  const warnings = [];
  if (!suppliedTotal && !extractedTotal) warnings.push("V08");
  if (FOREIGN_CURRENCY.test(normalized)) warnings.push("V12");
  if (items.length === 1 && structured.length === 0 && specialized.length === 0) items[0]._warnings.push("V03");

  const detectedTextUrl = (normalized.match(/https?:\/\/[^\s)\]]+/i) ?? [])[0];
  const detectedSourceUrl = options.sourceUrl || specialized.find((item) => item.sourceUrl)?.sourceUrl || (detectedTextUrl ? cleanScrapedUrl(detectedTextUrl) : undefined);

  return {
    mall: elevenStreet.length ? "11번가" : yes24.length ? "YES24" : mallFromUrl(detectedSourceUrl),
    sourceUrl: detectedSourceUrl || undefined,
    orderNo: findOrderNo(lines),
    capturedAt: new Date().toISOString(),
    paidTotal,
    _warnings: warnings,
    _extractedBy: "clipboard",
    items,
  };
}
