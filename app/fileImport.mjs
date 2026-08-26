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

const pdfMoneyValues = (value) => {
  const matches = cleanPdfCell(value).match(/(?:\d[\d,]*\s*원|\d{1,3}(?:,\d{3})+)/g) ?? [];
  return matches.map((match) => Number(match.replace(/[^\d]/g, ""))).filter((amount) => amount > 0);
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
  .replace(/(\d)\s+(개입|박스|자루|권|매|세트|팩|롤|속|개)(?![가-힣A-Za-z0-9])/g, "$1$2")
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

const teachermallShippingMoney = (value) => {
  const cleaned = cleanPdfCell(value).replace(/\s*원\s*$/, "");
  const clipped = cleaned.match(/^(\d{1,3}),(\d{2})$/);
  return clipped ? Number(`${clipped[1]}${clipped[2]}0`) : pdfMoney(cleaned);
};

export function teachermallPositionedPagesToOrder(positionedPages) {
  const pages = normalizedPdfPages(positionedPages);
  const documentText = pdfDocumentText(positionedPages).replace(/\s+/g, "");
  if (!/티처몰|shop\.teacherville\.co\.kr/i.test(documentText)
    || !/주문상품/.test(documentText)
    || !/할인적용금액/.test(documentText)) return null;

  const expectedProductCount = pages.flat().filter((cell) => /^상품번호\s+\d+/i.test(cell.value)).length;
  const items = pages.flatMap((cells) => {
    const productNumberCells = cells
      .filter((cell) => cell.x >= 60 && cell.x < 330 && /^상품번호\s+\d+/i.test(cell.value))
      .sort((a, b) => b.y - a.y);

    return productNumberCells.flatMap((numberCell, index) => {
      const lowerY = productNumberCells[index + 1]?.y ?? numberCell.y - 45;
      const region = cells.filter((cell) => cell.y <= numberCell.y + 2 && cell.y > lowerY);
      const nameRows = region
        .filter((cell) => cell.x >= 60 && cell.x < 325 && cell.y < numberCell.y && numberCell.y - cell.y <= 18)
        .filter((cell) => !/^(?:옵션|비과세|상품번호)/i.test(cell.value))
        .map((cell) => cell.y)
        .filter((rowY, rowIndex, rows) => rows.findIndex((candidate) => Math.abs(candidate - rowY) <= 3) === rowIndex)
        .sort((a, b) => b - a);
      const nameRowY = nameRows[0];
      const name = nameRowY == null ? "" : tidyPdfProductName(cellsNearRow(region, nameRowY)
        .filter((cell) => cell.x >= 60 && cell.x < 325)
        .map((cell) => cell.value)
        .join(" "));
      const quantityCell = region
        .filter((cell) => cell.x >= 325 && cell.x < 380 && /^\d{1,4}$/.test(cell.value))
        .sort((a, b) => b.y - a.y)[0];
      const quantity = Number(quantityCell?.value ?? 0);
      const amountRow = quantityCell ? cellsNearRow(region, quantityCell.y, 4) : [];
      const amount = pdfMoneyValues(amountRow
        .filter((cell) => cell.x >= 380 && cell.x < 550)
        .sort((a, b) => a.x - b.x)
        .map((cell) => cell.value)
        .join(" ")).at(-1) ?? 0;
      if (!name || !quantity || !amount) return [];

      const optionLabel = region.find((cell) => cell.x >= 60 && cell.x < 100 && cell.value === "옵션");
      const spec = optionLabel ? tidyPdfProductName(cellsNearRow(region, optionLabel.y, 3)
        .filter((cell) => cell.x > optionLabel.x && cell.x < 325)
        .map((cell) => cell.value)
        .join(" ")) : "";
      const productNumber = numberCell.value.match(/\d+/)?.[0] ?? "";
      const product = {
        내용: name,
        규격: spec,
        단위: "개",
        수량: quantity,
        단가: Math.round(amount / quantity),
        금액: amount,
        _rawName: `상품번호 ${productNumber} | ${name} | ${spec || "옵션 없음"} | ${quantity}개 | ${amount}원`,
        _warnings: amount % quantity === 0 ? [] : ["V06"],
        excluded: false,
      };

      const carrierCell = region
        .filter((cell) => cell.x >= 550 && /^택배$/i.test(cell.value))
        .sort((a, b) => b.y - a.y)[0];
      const deliveryRowY = carrierCell && region
        .filter((cell) => cell.x >= 550 && cell.y < carrierCell.y && carrierCell.y - cell.y <= 18)
        .map((cell) => cell.y)
        .sort((a, b) => b - a)[0];
      const deliveryText = deliveryRowY == null ? "" : cellsNearRow(region, deliveryRowY, 3)
        .filter((cell) => cell.x >= 550)
        .sort((a, b) => a.x - b.x)
        .map((cell) => cell.value)
        .join(" ");
      const isClippedRightEdgeMoney = /^\d{1,3},\d{2}$/.test(deliveryText);
      const shippingAmount = /무료/i.test(deliveryText) || (!/원/i.test(deliveryText) && !isClippedRightEdgeMoney)
        ? 0
        : teachermallShippingMoney(deliveryText);
      return shippingAmount > 0 ? [product, {
        내용: "배송비", 규격: "", 단위: "건", 수량: 1, 단가: shippingAmount, 금액: shippingAmount,
        _rawName: `상품번호 ${productNumber} | 배송비 ${shippingAmount}원`, _warnings: [], excluded: false,
      }] : [product];
    });
  });

  if (expectedProductCount && items.filter((item) => item.내용 !== "배송비").length !== expectedProductCount) return null;
  return positionedPdfOrder("티처몰", "teachermall-pdf-table", items);
}

const KYOBO_PDF_TITLE = /^\[(?:국내도서|보유외서|외국도서|eBook|오디오북|중고도서)\]\S/i;

const joinKyoboPdfTitle = (cells) => cells.reduce((title, cell, index) => {
  if (index === 0) return cell.value;
  const previous = cells[index - 1];
  const previousWidth = Number(previous.width);
  const gap = Number.isFinite(previousWidth) ? cell.x - (previous.x + previousWidth) : 0;
  return `${title}${gap > 0.8 ? " " : ""}${cell.value}`;
}, "");

const splitKyoboPdfTitle = (value) => {
  const cleaned = cleanPdfCell(value);
  const inline = cleaned.match(/^(.*\S)\s+(\d{1,4})\s*개\s*$/i);
  return {
    name: (inline?.[1] ?? cleaned).trim(),
    quantity: Number(inline?.[2] ?? 0),
  };
};

export function kyoboPositionedPagesToOrder(positionedPages) {
  const pages = normalizedPdfPages(positionedPages);
  const documentText = pdfDocumentText(positionedPages).replace(/\s+/g, "");
  if (!/교보문고|order\.kyobobook\.co\.kr/i.test(documentText) || !/주문상품/.test(documentText)) return null;

  const items = pages.flatMap((cells) => {
    const titleRows = cells
      .filter((cell) => cell.x >= 145 && cell.x < 410)
      .map((cell) => cell.y)
      .filter((rowY, index, rows) => rows.findIndex((candidate) => Math.abs(candidate - rowY) <= 2) === index)
      .map((rowY) => ({
        y: rowY,
        value: joinKyoboPdfTitle(cellsNearRow(cells, rowY, 2)
          .filter((cell) => cell.x >= 145 && cell.x < 410)),
      }))
      .filter((row) => KYOBO_PDF_TITLE.test(row.value))
      .sort((a, b) => b.y - a.y);

    return titleRows.flatMap((titleRow) => {
      const title = splitKyoboPdfTitle(titleRow.value);
      const quantityText = cells
        .filter((cell) => cell.x >= 420 && cell.x < 455 && Math.abs(cell.y - titleRow.y) <= 8)
        .sort((a, b) => a.x - b.x)
        .map((cell) => cell.value)
        .join("");
      const quantity = title.quantity || Number(quantityText.match(/(\d{1,4})\s*개/)?.[1] ?? 0);
      const discountedRows = cells
        .filter((cell) => cell.x >= 470 && cell.x < 515 && Math.abs(cell.y - titleRow.y) <= 13)
        .filter((cell) => /^\d[\d,]*$/.test(cell.value) && pdfMoney(cell.value) > 0)
        .sort((a, b) => b.y - a.y);
      const amountCell = discountedRows[0];
      const amount = pdfMoney(amountCell?.value);
      const name = tidyPdfProductName(title.name);
      if (!name || !quantity || !amount) return [];

      const unitPrice = Math.round(amount / quantity);
      return [{
        내용: name,
        규격: "",
        단위: "권",
        수량: quantity,
        단가: unitPrice,
        금액: amount,
        _rawName: `${name} | ${quantityText} | ${amountCell.value}`,
        _warnings: amount === quantity * unitPrice ? [] : ["V06"],
        excluded: false,
      }];
    });
  });

  if (!items.length) return null;
  return positionedPdfOrder("교보문고", "kyobo-pdf-cards", items);
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
  const expectedProductCount = Number(documentText.match(/주문상품(\d{1,3})개/)?.[1] ?? 0);

  const items = pages.flatMap((cells) => {
    const quantityLabels = cells
      .filter((cell) => cell.x >= 100 && cell.x < 155 && cell.value === "수량")
      .filter((quantityLabel) => {
        const row = cellsNearRow(cells, quantityLabel.y);
        const quantityCell = row.find((cell) => cell.x > quantityLabel.x && cell.x < quantityLabel.x + 30 && /^\d{1,3}$/.test(cell.value));
        return Boolean(quantityCell && row.some((cell) => cell.x > quantityCell.x && cell.x < quantityCell.x + 20 && /^(?:개|세트|팩|박스|권|매|병|봉|묶음|식)$/.test(cell.value)));
      })
      .sort((a, b) => b.y - a.y);
    return quantityLabels.flatMap((quantityLabel, index) => {
      const quantityRow = cellsNearRow(cells, quantityLabel.y);
      const quantityCell = quantityRow.find((cell) => cell.x > quantityLabel.x && /^\d{1,3}$/.test(cell.value));
      if (!quantityCell) return [];

      const previousQuantityY = quantityLabels[index - 1]?.y;
      const nameUpperY = previousQuantityY
        ? (quantityLabel.y + previousQuantityY) / 2
        : quantityLabel.y + 80;
      const detailRows = cells
        .filter((cell) => cell.x >= 100 && cell.x < 400 && cell.y > quantityLabel.y && cell.y <= nameUpperY)
        .map((cell) => cell.y)
        .filter((rowY, rowIndex, rows) => rows.findIndex((candidate) => Math.abs(candidate - rowY) <= 3) === rowIndex)
        .map((rowY) => ({
          rowY,
          text: cleanPdfCell(cellsNearRow(cells, rowY)
            .filter((cell) => cell.x >= 100 && cell.x < 400)
            .map((cell) => cell.value)
            .join(" ")),
        }))
        .filter((row) => row.text
          && !/^\d*\s*(?:개|건|세트|팩|박스|권|매|병|봉|묶음|식)$/i.test(row.text)
          && !/^(?:쿠폰\s*적용|무료\s*배송|배송비|오늘|내일|모레|도착|판매자|주문상품|최대\s*할인)/i.test(row.text))
        .sort((a, b) => b.rowY - a.rowY);
      const specRows = detailRows.filter((row) => (
        /^(?:옵션|선택|색상|사이즈|규격|단일상품)(?:\s|[:：×>]|$)|총\s*수량/i.test(row.text)
        || /(?:\d+(?:\.\d+)?\s*[x×*]\s*)+\d+(?:\.\d+)?\s*(?:mm|cm|m)\b/i.test(row.text)
      ));
      const spec = tidyPdfProductName(specRows.map((row) => row.text).join(" "));
      const name = tidyPdfProductName(detailRows
        .filter((row) => !specRows.includes(row))
        .slice(-2)
        .map((row) => row.text)
        .join(" "));
      const priceCell = cells
        .filter((cell) => cell.x >= 315 && cell.x < 400 && cell.y < quantityLabel.y && quantityLabel.y - cell.y <= 42 && pdfMoney(cell.value) > 0)
        .sort((a, b) => a.y - b.y)[0];
      const quantity = Number(quantityCell.value);
      const amount = pdfMoney(priceCell?.value);
      const unitPrice = quantity ? Math.round(amount / quantity) : 0;
      if (!name || !quantity || !amount || !unitPrice) return [];
      const product = {
        내용: name,
        규격: spec,
        단위: "개",
        수량: quantity,
        단가: unitPrice,
        금액: amount,
        _rawName: `${name} | ${spec || "규격 없음"} | 수량 ${quantity}개 | ${priceCell.value}`,
        _warnings: amount === quantity * unitPrice ? [] : ["V06"],
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
  if (expectedProductCount && items.filter((item) => item.내용 !== "배송비").length !== expectedProductCount) return null;
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

const PAPER_QUOTE_HEADERS = {
  sequence: /^(?:번호|순번|no\.?)$/i,
  name: /^(?:품목|품명|내용|상품명|제품명|물품명)$/i,
  quantity: /^(?:수량|주문수량)$/i,
  unitPrice: /^(?:단가|판매단가|공급단가|가격)$/i,
  amount: /^(?:공급가액|금액|예상금액|합계금액)$/i,
  remark: /^비고$/i,
};

const paperHeaderKind = (value) => {
  const normalized = normalizedHeader(value);
  return Object.entries(PAPER_QUOTE_HEADERS)
    .find(([, pattern]) => pattern.test(normalized))?.[0];
};

const pdfCellCenter = (cell) => cell.x + (Number(cell.width) || 0) / 2;

const groupPaperRows = (cells, tolerance = 3) => {
  const rows = [];
  for (const cell of [...cells].sort((a, b) => Math.abs(b.y - a.y) > tolerance ? b.y - a.y : a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - cell.y) <= tolerance);
    if (row) row.cells.push(cell);
    else rows.push({ y: cell.y, cells: [cell] });
  }
  return rows.map((row) => ({ ...row, cells: row.cells.sort((a, b) => a.x - b.x) }));
};

const joinPaperNameCells = (cells) => {
  const rowTexts = groupPaperRows(cells).map((row) => row.cells.reduce((result, cell, index) => {
    if (index === 0) return cell.value;
    const previous = row.cells[index - 1];
    const gap = cell.x - (previous.x + (Number(previous.width) || 0));
    return `${result}${gap > 1.2 ? " " : ""}${cell.value}`;
  }, ""));
  return tidyPdfProductName(rowTexts.reduce((result, rowText) => {
    if (!result) return rowText;
    return `${result}${/[가-힣]$/u.test(result) && /^[가-힣]$/u.test(rowText) ? "" : " "}${rowText}`;
  }, ""));
};

export function paperQuotePositionedPagesToOrder(positionedPages) {
  const pages = normalizedPdfPages(positionedPages);
  const documentText = pdfDocumentText(positionedPages);
  const compactDocumentText = documentText.replace(/\s+/g, "");
  const productItems = [];

  for (const cells of pages) {
    const headerCandidates = groupPaperRows(cells).map((row) => {
      const columns = {};
      for (const cell of row.cells) {
        const kind = paperHeaderKind(cell.value);
        if (kind && !columns[kind]) columns[kind] = cell;
      }
      const required = [columns.quantity, columns.unitPrice, columns.amount].filter(Boolean).length;
      const context = [columns.sequence, columns.name, columns.remark].filter(Boolean).length;
      return { ...row, columns, score: required * 10 + context };
    }).filter((candidate) => candidate.score >= 31)
      .sort((a, b) => b.score - a.score || b.y - a.y);
    const header = headerCandidates[0];
    if (!header) continue;

    const quantityCenter = pdfCellCenter(header.columns.quantity);
    const unitPriceCenter = pdfCellCenter(header.columns.unitPrice);
    const amountCenter = pdfCellCenter(header.columns.amount);
    if (!(quantityCenter < unitPriceCenter && unitPriceCenter < amountCenter)) continue;

    const unitPriceLeft = (quantityCenter + unitPriceCenter) / 2;
    const amountLeft = (unitPriceCenter + amountCenter) / 2;
    const amountRight = header.columns.remark
      ? (amountCenter + pdfCellCenter(header.columns.remark)) / 2
      : Number.POSITIVE_INFINITY;
    const quantityWidth = Math.max(12, (unitPriceCenter - quantityCenter) * 0.45);
    const nameRight = quantityCenter - quantityWidth;
    const sequenceCenter = header.columns.sequence ? pdfCellCenter(header.columns.sequence) : 0;
    const nameLeft = header.columns.sequence
      ? sequenceCenter + Math.max(7, (nameRight - sequenceCenter) * 0.035)
      : Math.min(...cells.map((cell) => cell.x)) - 1;

    const totalLabels = cells
      .filter((cell) => cell.y < header.y - 3 && /^(?:합계|총계)$/i.test(cell.value))
      .sort((a, b) => b.y - a.y);
    const totalY = totalLabels[0]?.y;
    const insideDataRows = (cell) => cell.y < header.y - 3 && (totalY == null || cell.y > totalY + 3);
    const sequenceCandidates = header.columns.sequence ? cells
      .filter((cell) => insideDataRows(cell) && cell.x < nameLeft && /^\d{1,4}$/.test(cell.value))
      .map((cell) => ({ ...cell, order: Number(cell.value) }))
      .filter((cell) => cell.order > 0 && cell.order <= 999)
      .sort((a, b) => b.y - a.y) : [];
    const sequenceAnchors = sequenceCandidates.filter((cell, index, candidates) => (
      index === 0 || cell.order > candidates[index - 1].order
    ));
    const quantityAnchors = cells
      .filter((cell) => insideDataRows(cell)
        && cell.x >= nameRight && cell.x < unitPriceLeft
        && /^\d{1,4}$/.test(cell.value))
      .sort((a, b) => b.y - a.y);
    const anchors = sequenceAnchors.length ? sequenceAnchors : quantityAnchors;
    if (!anchors.length) continue;

    const pageItems = anchors.flatMap((anchor, index) => {
      const upperY = index === 0 ? header.y - 3 : (anchors[index - 1].y + anchor.y) / 2;
      const lowerY = index === anchors.length - 1
        ? (totalY == null ? anchor.y - 24 : totalY + 3)
        : (anchor.y + anchors[index + 1].y) / 2;
      const region = cells.filter((cell) => cell.y < upperY && cell.y >= lowerY);
      const nameCells = region
        .filter((cell) => cell.x >= nameLeft && cell.x < nameRight)
        .filter((cell) => !paperHeaderKind(cell.value))
        .filter((cell) => !/^(?:합계|총계|소계|배송비|포장비|분철비|반품비)$/i.test(cell.value));
      const name = joinPaperNameCells(nameCells);
      const quantityCell = region
        .filter((cell) => cell.x >= nameRight && cell.x < unitPriceLeft && /^\d{1,4}$/.test(cell.value))
        .sort((a, b) => Math.abs(a.y - anchor.y) - Math.abs(b.y - anchor.y))[0];
      const unitPriceCell = region
        .filter((cell) => cell.x >= unitPriceLeft && cell.x < amountLeft && pdfMoney(cell.value) > 0)
        .sort((a, b) => Math.abs(a.y - anchor.y) - Math.abs(b.y - anchor.y))[0];
      const amountCell = region
        .filter((cell) => cell.x >= amountLeft && cell.x < amountRight && pdfMoney(cell.value) > 0)
        .sort((a, b) => Math.abs(a.y - anchor.y) - Math.abs(b.y - anchor.y))[0];
      const quantity = Number(quantityCell?.value ?? 0);
      const unitPrice = pdfMoney(unitPriceCell?.value);
      const amount = pdfMoney(amountCell?.value);
      if (!name || !quantity || !unitPrice || !amount) return [];
      return [{
        내용: name,
        규격: "",
        단위: /예스24|예스이십사|YES24|서적/i.test(compactDocumentText) ? "권" : "개",
        수량: quantity,
        단가: unitPrice,
        금액: amount,
        _rawName: `${header.columns.sequence ? `${anchor.value} | ` : ""}${name} | ${quantity} | ${unitPriceCell.value} | ${amountCell.value}`,
        _warnings: amount === quantity * unitPrice ? [] : ["V06"],
        excluded: false,
      }];
    });
    if (pageItems.length !== anchors.length) return null;
    productItems.push(...pageItems);
  }

  if (!productItems.length) return null;
  const feeItems = pages.flatMap((cells) => groupPaperRows(cells).flatMap((row) => {
    const labels = row.cells
      .filter((cell) => /^(?:배송비|포장비|분철비|반품비)$/i.test(cell.value))
      .sort((a, b) => a.x - b.x);
    return labels.flatMap((label, index) => {
      const right = labels[index + 1]?.x ?? Number.POSITIVE_INFINITY;
      const amountCell = row.cells
        .filter((cell) => cell.x > label.x && cell.x < right && pdfMoney(cell.value) >= 0)
        .sort((a, b) => a.x - b.x)
        .find((cell) => /\d/.test(cell.value));
      const amount = pdfMoney(amountCell?.value);
      return amount > 0 ? [{
        내용: label.value, 규격: "", 단위: "건", 수량: 1, 단가: amount, 금액: amount,
        _rawName: `${label.value} ${amount}원`, _warnings: [], excluded: false,
      }] : [];
    });
  }));
  const items = [...productItems, ...feeItems];
  const totalCandidates = pages.flatMap((cells) => cells
    .filter((cell) => /^(?:합계|총계|총액)$/i.test(cell.value))
    .flatMap((label) => pdfMoneyValues(cellsNearRow(cells, label.y, 3)
      .filter((cell) => cell.x >= label.x)
      .map((cell) => cell.value)
      .join(" "))));
  const documentedTotal = totalCandidates.length ? Math.max(...totalCandidates) : 0;
  const mall = /예스24|예스이십사|YES24/i.test(compactDocumentText)
    ? "YES24 견적서"
    : "종이 견적서·영수증";
  return positionedPdfOrder(mall, "paper-quote-pdf-table", items, documentedTotal);
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
      .map((item) => ({ value: item.str.trim(), x: item.transform[4], y: item.transform[5], width: item.width }))
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
    teachermallPositionedPagesToOrder,
    mananPositionedPagesToOrder,
    kyoboPositionedPagesToOrder,
    yes24PositionedPagesToOrder,
    gmarketPositionedPagesToOrder,
    elevenStreetPositionedPagesToOrder,
    iscreamPositionedPagesToOrder,
    paperQuotePositionedPagesToOrder,
  ]) {
    const positionedOrder = parser(positionedPages);
    if (positionedOrder) return positionedOrder;
  }
  const order = parseOrderText(lines.join("\n"));
  order._extractedBy = "pdf-text";
  return order;
}
