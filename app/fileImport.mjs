import { parseOrderText } from "./orderTextParser.mjs";

const HEADER_ALIASES = {
  name: ["내용", "품명", "상품명", "제품명", "물품명"],
  spec: ["규격", "옵션", "사양"],
  unit: ["단위"],
  qty: ["수량", "주문수량"],
  price: ["예상단가", "단가", "판매가", "가격"],
  amount: ["예상금액", "금액", "상품금액", "결제금액"],
};

const text = (value) => value == null ? "" : String(value).trim();
const number = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
  const parsed = Number(text(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};
const normalizedHeader = (value) => text(value).replace(/\s+/g, "").toLowerCase();

function findColumn(header, aliases) {
  return header.findIndex((cell) => aliases.includes(cell));
}

export function spreadsheetRowsToOrder(rows, filename) {
  const cleanRows = rows.map((row) => row.map(text));
  const headerIndex = cleanRows.slice(0, 25).findIndex((row) => {
    const header = row.map(normalizedHeader);
    return findColumn(header, HEADER_ALIASES.name) >= 0
      && findColumn(header, HEADER_ALIASES.qty) >= 0
      && (findColumn(header, HEADER_ALIASES.price) >= 0 || findColumn(header, HEADER_ALIASES.amount) >= 0);
  });

  if (headerIndex < 0) {
    return parseOrderText(cleanRows.map((row) => row.join("\t")).join("\n"));
  }

  const header = cleanRows[headerIndex].map(normalizedHeader);
  const columns = {
    name: findColumn(header, HEADER_ALIASES.name),
    spec: findColumn(header, HEADER_ALIASES.spec),
    unit: findColumn(header, HEADER_ALIASES.unit),
    qty: findColumn(header, HEADER_ALIASES.qty),
    price: findColumn(header, HEADER_ALIASES.price),
    amount: findColumn(header, HEADER_ALIASES.amount),
  };

  const items = cleanRows.slice(headerIndex + 1).flatMap((row) => {
    const name = text(row[columns.name]);
    if (!name || /^(합계|총계|전체\s*합계|소계)$/i.test(name)) return [];
    const qty = Math.max(1, number(row[columns.qty]) || 1);
    const suppliedPrice = columns.price >= 0 ? number(row[columns.price]) : 0;
    const suppliedAmount = columns.amount >= 0 ? number(row[columns.amount]) : 0;
    const price = suppliedPrice || (suppliedAmount ? Math.round(suppliedAmount / qty) : 0);
    if (!price && !suppliedAmount) return [];
    const amount = suppliedAmount || qty * price;
    const warnings = [];
    if (!price) warnings.push("V05");
    if (amount !== qty * price) warnings.push("V06");
    return [{
      내용: name,
      규격: columns.spec >= 0 ? text(row[columns.spec]) : "",
      단위: columns.unit >= 0 ? text(row[columns.unit]) || "개" : "개",
      수량: qty,
      단가: price,
      금액: amount,
      _rawName: row.join(" | "),
      _warnings: warnings,
      excluded: false,
    }];
  }).slice(0, 120);

  if (!items.length) throw new Error("[V-P02] 엑셀에서 품목 행을 찾지 못했습니다.");
  const calculatedTotal = items.reduce((sum, item) => sum + item.금액, 0);
  const totalRow = cleanRows.slice(headerIndex + 1).find((row) => row.some((cell) => /^(합계|총계|전체\s*합계|결제\s*금액)$/i.test(cell)));
  const documentedTotal = totalRow ? [...totalRow].reverse().map(number).find((value) => value > 0) ?? 0 : 0;
  return {
    mall: filename.replace(/\.(xlsx|xls)$/i, ""),
    orderNo: "문서에서 가져옴",
    capturedAt: new Date().toISOString(),
    paidTotal: documentedTotal || calculatedTotal,
    _warnings: documentedTotal ? [] : ["V08"],
    _extractedBy: "spreadsheet",
    items,
  };
}

export async function importExcel(file) {
  const { default: readWorkbook } = await import("read-excel-file/browser");
  const sheets = await readWorkbook(file);
  const sheet = sheets.find((candidate) => candidate.data.some((row) => row.some((cell) => cell != null)));
  if (!sheet) throw new Error("[V-P02] 엑셀 문서가 비어 있습니다.");
  return spreadsheetRowsToOrder(sheet.data, file.name);
}

const cleanPdfCell = (value) => String(value ?? "")
  .replace(/[\u0000-\u001f]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const pdfMoney = (value) => {
  const match = cleanPdfCell(value).match(/\d[\d,]*/);
  return match ? Number(match[0].replaceAll(",", "")) : 0;
};

const MANAN_UNITS = "개|롤|속|자루|세트|팩|박스|권|매|병|봉|묶음|식";

export function mananPositionedPagesToOrder(positionedPages) {
  const allCells = positionedPages.flat().map((cell) => ({
    ...cell,
    value: cleanPdfCell(cell.value),
  })).filter((cell) => cell.value);
  const documentText = allCells.map((cell) => cell.value).join(" ");
  const isManan = /만안문구센터|mananmungu\.co\.kr/i.test(documentText);
  const hasTableHeader = /제품명/.test(documentText) && /판매단가/.test(documentText) && /수량/.test(documentText) && /합계/.test(documentText);
  if (!isManan || !hasTableHeader) return null;

  const items = positionedPages.flatMap((pageCells) => {
    const cells = pageCells.map((cell) => ({ ...cell, value: cleanPdfCell(cell.value) })).filter((cell) => cell.value);
    const priceCells = cells.filter((cell) => cell.x >= 420 && cell.x < 500 && /\d[\d,]*(?:\s*원)?/.test(cell.value) && pdfMoney(cell.value) > 0);
    return priceCells.flatMap((priceCell) => {
      const amountCell = cells
        .filter((cell) => cell.x >= 530 && Math.abs(cell.y - priceCell.y) <= 4 && pdfMoney(cell.value) > 0)
        .sort((a, b) => Math.abs(a.y - priceCell.y) - Math.abs(b.y - priceCell.y))[0];
      const quantityCells = cells
        .filter((cell) => cell.x >= 490 && cell.x < 535 && Math.abs(cell.y - priceCell.y) <= 9)
        .sort((a, b) => a.x - b.x);
      const nameCells = cells
        .filter((cell) => cell.x >= 135 && cell.x < 420 && Math.abs(cell.y - priceCell.y) <= 8)
        .filter((cell) => !/^(?:제품명|이미지|색상\s*:|point\s*0)$/i.test(cell.value))
        .sort((a, b) => a.x - b.x);
      const quantityText = cleanPdfCell(quantityCells.map((cell) => cell.value).join(" "));
      const quantityMatch = quantityText.match(new RegExp(`^(\\d{1,4})\\s*(${MANAN_UNITS})$`));
      const name = cleanPdfCell(nameCells.map((cell) => cell.value).join(" "));
      const unitPrice = pdfMoney(priceCell.value);
      const amount = pdfMoney(amountCell?.value);
      if (!name || !quantityMatch || !unitPrice || !amount) return [];

      const optionText = cells
        .filter((cell) => cell.x >= 135 && cell.x < 420)
        .filter((cell) => {
          const distance = Math.abs(cell.y - priceCell.y);
          return distance > 8 && distance <= 18;
        })
        .sort((a, b) => a.x - b.x)
        .map((cell) => cell.value)
        .join(" ");
      const spec = /색상\s*:/i.test(optionText)
        ? optionText.replace(/^.*?색상\s*:\s*/i, "").trim()
        : "";
      const quantity = Number(quantityMatch[1]);
      const warnings = amount === unitPrice * quantity ? [] : ["V06"];
      return [{
        내용: name,
        규격: spec,
        단위: quantityMatch[2],
        수량: quantity,
        단가: unitPrice,
        금액: amount,
        _rawName: `${name} | ${priceCell.value} | ${quantityText} | ${amountCell.value}`,
        _warnings: warnings,
        excluded: false,
      }];
    });
  }).slice(0, 120);

  if (!items.length) return null;
  const calculatedTotal = items.reduce((sum, item) => sum + item.금액, 0);
  const totalLabel = allCells.find((cell) => /구입총액/.test(cell.value));
  const totalAmountCell = totalLabel && allCells
    .filter((cell) => cell.x > totalLabel.x && Math.abs(cell.y - totalLabel.y) <= 4 && pdfMoney(cell.value) > 0)
    .sort((a, b) => a.x - b.x)[0];
  const documentedTotal = pdfMoney(totalLabel?.value) || pdfMoney(totalAmountCell?.value) || calculatedTotal;
  return {
    mall: "만안문구센터",
    orderNo: "PDF 문서에서 가져옴",
    capturedAt: new Date().toISOString(),
    paidTotal: documentedTotal,
    _warnings: documentedTotal === calculatedTotal ? [] : ["V07"],
    _extractedBy: "manan-pdf-table",
    items,
  };
}

const normalizedPdfPages = (positionedPages) => positionedPages.map((pageCells) => pageCells
  .map((cell) => ({ ...cell, value: cleanPdfCell(cell.value) }))
  .filter((cell) => cell.value));

const pdfDocumentText = (positionedPages) => normalizedPdfPages(positionedPages)
  .flat()
  .map((cell) => cell.value)
  .join(" ");

const cellsNearRow = (cells, y, tolerance = 3) => cells
  .filter((cell) => Math.abs(cell.y - y) <= tolerance)
  .sort((a, b) => a.x - b.x);

const tidyPdfProductName = (value) => cleanPdfCell(value)
  .replace(/\s+([),])/g, "$1")
  .replace(/\(\s+/g, "(")
  .replace(/(\d)\s+(개입|박스|자루|권|매|세트|팩|롤|속|개)/g, "$1$2")
  .replace(/\s+\S+\s*…$/u, "")
  .replace(/복합\s+기/g, "복합기")
  .trim();

function positionedPdfOrder(mall, extractedBy, items, documentedTotal = 0) {
  if (!items.length) return null;
  const calculatedTotal = items.reduce((sum, item) => sum + item.금액, 0);
  const paidTotal = documentedTotal || calculatedTotal;
  return {
    mall,
    orderNo: "PDF 문서에서 가져옴",
    capturedAt: new Date().toISOString(),
    paidTotal,
    _warnings: paidTotal === calculatedTotal ? [] : ["V07"],
    _extractedBy: extractedBy,
    items: items.slice(0, 120),
  };
}

export function yes24PositionedPagesToOrder(positionedPages) {
  const pages = normalizedPdfPages(positionedPages);
  const documentText = pdfDocumentText(positionedPages).replace(/\s+/g, "");
  if (!/예스24|YES24/i.test(documentText) || !/상품명.*정가.*수량.*할인금액.*합계/i.test(documentText)) return null;

  const items = pages.flatMap((cells) => {
    const titles = cells
      .filter((cell) => cell.x >= 170 && cell.x < 410 && /^\[도서\]/.test(cell.value))
      .sort((a, b) => b.y - a.y);
    return titles.flatMap((titleCell, index) => {
      const lowerY = titles[index + 1]?.y ?? titleCell.y - 65;
      const region = cells.filter((cell) => cell.y <= titleCell.y + 2 && cell.y > lowerY);
      const quantityCell = region
        .filter((cell) => cell.x >= 465 && cell.x < 500 && /^\d{1,3}$/.test(cell.value))
        .sort((a, b) => b.y - a.y)[0];
      const discountedCell = region
        .filter((cell) => cell.x >= 500 && cell.x < 540 && /\d[\d,]*\s*원/.test(cell.value) && pdfMoney(cell.value) > 0)
        .sort((a, b) => b.y - a.y)[0];
      const amountCell = region
        .filter((cell) => cell.x >= 540 && /\d[\d,]*\s*원/.test(cell.value) && pdfMoney(cell.value) > 0)
        .sort((a, b) => b.y - a.y)[0];
      const quantity = Number(quantityCell?.value ?? 0);
      const unitPrice = pdfMoney(discountedCell?.value);
      const amount = pdfMoney(amountCell?.value);
      const name = tidyPdfProductName(titleCell.value.replace(/^\[도서\]\s*/, ""));
      if (!name || !quantity || !unitPrice || !amount) return [];
      return [{
        내용: name,
        규격: "도서",
        단위: "권",
        수량: quantity,
        단가: unitPrice,
        금액: amount,
        _rawName: `${titleCell.value} | ${quantity} | ${discountedCell.value} | ${amountCell.value}`,
        _warnings: amount === quantity * unitPrice ? [] : ["V06"],
        excluded: false,
      }];
    });
  });
  return positionedPdfOrder("YES24", "yes24-pdf-table", items);
}

export function gmarketPositionedPagesToOrder(positionedPages) {
  const pages = normalizedPdfPages(positionedPages);
  const documentText = pdfDocumentText(positionedPages).replace(/\s+/g, "");
  if (!/G마켓|checkout\.gmarket\.co\.kr/i.test(documentText) || !/주문상품/.test(documentText)) return null;

  const items = pages.flatMap((cells) => {
    const quantityLabels = cells
      .filter((cell) => cell.x >= 100 && cell.x < 155 && cell.value === "수량")
      .sort((a, b) => b.y - a.y);
    return quantityLabels.flatMap((quantityLabel, index) => {
      const quantityRow = cellsNearRow(cells, quantityLabel.y);
      const quantityCell = quantityRow.find((cell) => cell.x > quantityLabel.x && /^\d{1,3}$/.test(cell.value));
      const nameAnchor = cells
        .filter((cell) => cell.x >= 100 && cell.x < 400 && cell.y > quantityLabel.y && cell.y <= quantityLabel.y + 22)
        .sort((a, b) => Math.abs(a.y - quantityLabel.y) - Math.abs(b.y - quantityLabel.y))[0];
      if (!quantityCell || !nameAnchor) return [];
      const name = tidyPdfProductName(cellsNearRow(cells, nameAnchor.y)
        .filter((cell) => cell.x >= 100 && cell.x < 400)
        .map((cell) => cell.value)
        .join(" "));
      const priceCell = cells
        .filter((cell) => cell.x >= 315 && cell.x < 400 && cell.y < quantityLabel.y && quantityLabel.y - cell.y <= 42 && pdfMoney(cell.value) > 0)
        .sort((a, b) => a.y - b.y)[0];
      const quantity = Number(quantityCell.value);
      const unitPrice = pdfMoney(priceCell?.value);
      if (!name || !quantity || !unitPrice) return [];
      const product = {
        내용: name,
        규격: "",
        단위: "개",
        수량: quantity,
        단가: unitPrice,
        금액: quantity * unitPrice,
        _rawName: `${name} | 수량 ${quantity}개 | ${priceCell.value}`,
        _warnings: [],
        excluded: false,
      };

      const lowerY = quantityLabels[index + 1]?.y ? quantityLabels[index + 1].y + 20 : quantityLabel.y - 90;
      const shippingRows = [...new Set(cells
        .filter((cell) => cell.y < quantityLabel.y && cell.y > lowerY && /배송비|무료배송|구매시/.test(cell.value))
        .map((cell) => cell.y))];
      const shippingAmount = shippingRows.reduce((found, rowY) => {
        const outcomes = cellsNearRow(cells, rowY)
          .flatMap((cell) => {
            if (/무료배송/.test(cell.value)) return [{ x: cell.x, amount: 0 }];
            const amount = cell.x >= 320 ? pdfMoney(cell.value) : 0;
            return amount > 0 && amount <= 10000 ? [{ x: cell.x, amount }] : [];
          })
          .sort((a, b) => a.x - b.x);
        return outcomes.at(-1)?.amount ?? found;
      }, 0);
      return shippingAmount > 0 ? [product, {
        내용: "배송비", 규격: "", 단위: "건", 수량: 1, 단가: shippingAmount, 금액: shippingAmount,
        _rawName: `배송비 ${shippingAmount}원`, _warnings: [], excluded: false,
      }] : [product];
    });
  });
  return positionedPdfOrder("G마켓", "gmarket-pdf-cards", items);
}

export function elevenStreetPositionedPagesToOrder(positionedPages) {
  const pages = normalizedPdfPages(positionedPages);
  const documentText = pdfDocumentText(positionedPages).replace(/\s+/g, "");
  if (!/11번가|buy\.11st\.co\.kr/i.test(documentText) || !/주문상품/.test(documentText)) return null;

  const items = pages.flatMap((cells) => {
    if (!cells.some((cell) => cell.value === "주문상품")) return [];
    const quantityCells = cells
      .filter((cell) => cell.x >= 290 && cell.x < 315 && /^\d{1,3}$/.test(cell.value))
      .filter((cell) => cellsNearRow(cells, cell.y).some((candidate) => candidate.x > cell.x && candidate.x < 330 && candidate.value === "개"))
      .sort((a, b) => b.y - a.y);
    return quantityCells.flatMap((quantityCell) => {
      const name = tidyPdfProductName(cells
        .filter((cell) => cell.x >= 100 && cell.x < 290 && cell.y <= quantityCell.y + 4 && cell.y >= quantityCell.y - 22)
        .filter((cell) => !/^(?:상품쿠폰|적용중)$/.test(cell.value))
        .filter((cell) => !cellsNearRow(cells, cell.y).some((candidate) => /도착/.test(candidate.value)))
        .sort((a, b) => Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x)
        .map((cell) => cell.value)
        .join(" "));
      const priceCell = cells
        .filter((cell) => cell.x >= 330 && cell.x < 410 && Math.abs(cell.y - quantityCell.y) <= 4 && pdfMoney(cell.value) > 0)
        .sort((a, b) => a.x - b.x)[0];
      const quantity = Number(quantityCell.value);
      const unitPrice = pdfMoney(priceCell?.value);
      if (!name || !quantity || !unitPrice) return [];

      const optionLabel = cells
        .filter((cell) => cell.x >= 100 && cell.x < 145 && cell.y < quantityCell.y && quantityCell.y - cell.y <= 45 && cell.value === "옵션")
        .sort((a, b) => b.y - a.y)[0];
      const spec = optionLabel ? tidyPdfProductName(cellsNearRow(cells, optionLabel.y)
        .filter((cell) => cell.x > optionLabel.x && cell.x < 300)
        .map((cell) => cell.value)
        .join(" ")) : "";
      const product = {
        내용: name,
        규격: spec,
        단위: "개",
        수량: quantity,
        단가: unitPrice,
        금액: quantity * unitPrice,
        _rawName: `${name} | ${spec || "옵션 없음"} | ${quantity}개 | ${priceCell.value}`,
        _warnings: [],
        excluded: false,
      };
      const shippingAmount = cells
        .filter((cell) => cell.x >= 415 && Math.abs(cell.y - quantityCell.y) <= 10 && pdfMoney(cell.value) > 0)
        .map((cell) => pdfMoney(cell.value))
        .find((amount) => amount <= 10000) ?? 0;
      return shippingAmount > 0 ? [product, {
        내용: "배송비", 규격: "", 단위: "건", 수량: 1, 단가: shippingAmount, 금액: shippingAmount,
        _rawName: `선결제 배송비 ${shippingAmount}원`, _warnings: [], excluded: false,
      }] : [product];
    });
  });
  return positionedPdfOrder("11번가", "11st-pdf-table", items);
}

export function iscreamPositionedPagesToOrder(positionedPages) {
  const pages = normalizedPdfPages(positionedPages);
  const documentText = pdfDocumentText(positionedPages).replace(/\s+/g, "");
  if (!/아이스크림몰|i-screammall\.co\.kr/i.test(documentText) || !/주문상품/.test(documentText)) return null;

  const expectedProductCount = Number(documentText.match(/주문상품(\d{1,3})(?:건|개)/)?.[1] ?? 0);
  const documentedProductTotal = pages.reduce((found, cells) => {
    if (found) return found;
    const totalLabel = cells.find((cell) => /^상품금액$/.test(cell.value.replace(/\s+/g, "")));
    if (!totalLabel) return 0;
    return cellsNearRow(cells, totalLabel.y, 4)
      .filter((cell) => cell.x > totalLabel.x && pdfMoney(cell.value) > 0)
      .map((cell) => pdfMoney(cell.value))[0] ?? 0;
  }, 0);

  const items = pages.flatMap((cells) => {
    const quantityRows = cells
      .filter((cell) => cell.x >= 100 && cell.x < 430)
      .map((cell) => cell.y)
      .filter((rowY, index, rows) => rows.findIndex((candidate) => Math.abs(candidate - rowY) <= 3) === index)
      .map((rowY) => ({ rowY, text: cellsNearRow(cells, rowY).map((cell) => cell.value).join(" ") }))
      .filter((row) => /\/\s*\d{1,4}\s*(?:개|세트|팩|박스|권|매|병|봉|묶음|식)/.test(row.text))
      .sort((a, b) => b.rowY - a.rowY);

    return quantityRows.flatMap(({ rowY, text: quantityText }, rowIndex) => {
      const quantityMatch = quantityText.match(/\/\s*(\d{1,4})\s*(개|세트|팩|박스|권|매|병|봉|묶음|식)/);
      const quantity = Number(quantityMatch?.[1] ?? 0);
      const previousRowY = quantityRows[rowIndex - 1]?.rowY;
      const nameUpperY = previousRowY ? Math.min(rowY + 90, (rowY + previousRowY) / 2) : rowY + 90;
      const name = tidyPdfProductName(cells
        .filter((cell) => cell.x >= 100 && cell.x < 430 && cell.y > rowY && cell.y <= nameUpperY)
        .filter((cell) => !/^(?:합배송 상품|단일상품)$/.test(cell.value))
        .sort((a, b) => Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x)
        .map((cell) => cell.value)
        .join(" "));
      const amountCell = cells
        .filter((cell) => cell.x >= 100 && cell.x < 200 && cell.y < rowY && rowY - cell.y <= 30 && pdfMoney(cell.value) > 0)
        .sort((a, b) => b.y - a.y)[0];
      const amount = pdfMoney(amountCell?.value);
      const unitPrice = quantity ? Math.round(amount / quantity) : 0;
      if (!name || !quantity || !amount || !unitPrice) return [];
      const explicitSpec = quantityText
        .replace(/\s*\/\s*\d{1,4}\s*(?:개|세트|팩|박스|권|매|병|봉|묶음|식).*$/i, "")
        .trim();
      return [{
        내용: name,
        규격: explicitSpec || "",
        단위: quantityMatch?.[2] || "개",
        수량: quantity,
        단가: unitPrice,
        금액: amount,
        _rawName: `${name} | ${quantityText} | ${amountCell.value}`,
        _warnings: amount === quantity * unitPrice ? [] : ["V06"],
        excluded: false,
      }];
    });
  });
  const calculatedTotal = items.reduce((sum, item) => sum + item.금액, 0);
  if (expectedProductCount && items.length !== expectedProductCount) return null;
  if (documentedProductTotal && documentedProductTotal !== calculatedTotal) return null;
  return positionedPdfOrder("아이스크림몰", "iscream-pdf-cards", items, documentedProductTotal || calculatedTotal);
}

export async function importPdf(file, onProgress = (progress, label) => { void progress; void label; }) {
  onProgress(0.08, "PDF 글자를 읽고 있어요…");
  const pdfjs = await import("pdfjs-dist");
  const pageBaseUrl = typeof globalThis.document?.baseURI === "string"
    ? globalThis.document.baseURI
    : import.meta.url;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", pageBaseUrl).href;
  const pdfDocument = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  const positionedPages = [];

  for (let pageNo = 1; pageNo <= Math.min(pdfDocument.numPages, 20); pageNo += 1) {
    onProgress(0.08 + (pageNo / pdfDocument.numPages) * 0.72, `${pageNo}/${pdfDocument.numPages}쪽을 읽고 있어요…`);
    const page = await pdfDocument.getPage(pageNo);
    const content = await page.getTextContent();
    const positioned = content.items
      .filter((item) => "str" in item && item.str.trim())
      .map((item) => ({ value: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
      .sort((a, b) => Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x);
    positionedPages.push(positioned);
    const rows = [];
    for (const item of positioned) {
      const current = rows[rows.length - 1];
      if (!current || Math.abs(current.y - item.y) > 3) rows.push({ y: item.y, cells: [item.value] });
      else current.cells.push(item.value);
    }
    lines.push(...rows.map((row) => row.cells.join("\t")));
  }

  if (!lines.length) throw new Error("[V-P02] 글자가 없는 스캔 PDF입니다. 문자 인식(OCR)을 켜고 PDF로 다시 저장해 주세요.");
  onProgress(0.9, "품목과 금액을 구분하고 있어요…");
  for (const parser of [
    mananPositionedPagesToOrder,
    yes24PositionedPagesToOrder,
    gmarketPositionedPagesToOrder,
    elevenStreetPositionedPagesToOrder,
    iscreamPositionedPagesToOrder,
  ]) {
    const positionedOrder = parser(positionedPages);
    if (positionedOrder) return positionedOrder;
  }
  const order = parseOrderText(lines.join("\n"));
  order._extractedBy = "pdf-text";
  return order;
}

export async function importImage(file, onProgress = (progress, label) => { void progress; void label; }) {
  onProgress(0.03, "한글 인식 모델을 준비하고 있어요…");
  const tesseract = await import("tesseract.js");
  const worker = await tesseract.createWorker(["kor", "eng"], tesseract.OEM.LSTM_ONLY, {
    logger(message) {
      if (typeof message.progress === "number") {
        onProgress(Math.max(0.05, Math.min(0.92, message.progress)), "캡처에서 글자를 읽고 있어요…");
      }
    },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT, preserve_interword_spaces: "1" });
    const result = await worker.recognize(file);
    const order = parseOrderText(result.data.text);
    order._warnings = [...new Set([...(order._warnings ?? []), "V09"] )];
    order._extractedBy = "image-ocr";
    return order;
  } finally {
    await worker.terminate();
  }
}
