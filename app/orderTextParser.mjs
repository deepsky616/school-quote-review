const TOTAL_LABEL = /(총\s*결제|최종\s*결제|결제\s*(?:예정\s*)?금액|주문\s*금액|총\s*상품\s*금액|총액|합계)/i;
const HEADER_LABEL = /^(상품|상품명|품명|내용|옵션|규격|수량|단가|금액|결제금액|주문금액)$/i;
const CONTROL_LABEL = /^(장바구니|주문내역|주문상세|배송조회|리뷰쓰기|교환|반품|취소|문의|구매확정|다시 구매|닫기|확인)$/i;
const FOREIGN_CURRENCY = /(?:US?D|JPY|EUR|CNY|[$€¥])/i;

const toNumber = (value = "") => {
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

const moneyValues = (line) => {
  const matches = line.match(/(?:₩\s*\d[\d,]*|\d[\d,]*\s*원|\d{1,3}(?:,\d{3})+)/g) ?? [];
  return matches.map(toNumber).filter((value) => value >= 0);
};

const cleanName = (value) => value
  .replace(/(?:₩\s*\d[\d,]*|\d[\d,]*\s*원|\d{1,3}(?:,\d{3})+)/g, " ")
  .replace(/(?:판매가|상품금액|주문금액|금액|가격|단가)\s*[:：]?/gi, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 160);

const isNameCandidate = (line) => {
  const value = cleanName(line);
  if (value.length < 2 || HEADER_LABEL.test(value) || CONTROL_LABEL.test(value)) return false;
  if (/^(옵션|규격|수량|배송|도착|판매자|주문번호|결제|쿠폰|할인|포인트)\b/i.test(value)) return false;
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
  const structured = lines.map(structuredItem).filter(Boolean);
  const candidates = structured.length
    ? structured
    : lines.map((_, index) => textItem(lines, index)).filter(Boolean);

  const seen = new Set();
  const items = candidates.filter((item) => {
    const key = `${item.내용}|${item.수량}|${item.금액}`;
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
  if (items.length === 1 && structured.length === 0) items[0]._warnings.push("V03");

  return {
    mall: mallFromUrl(options.sourceUrl),
    sourceUrl: options.sourceUrl || undefined,
    orderNo: findOrderNo(lines),
    capturedAt: new Date().toISOString(),
    paidTotal,
    _warnings: warnings,
    _extractedBy: "clipboard",
    items,
  };
}
