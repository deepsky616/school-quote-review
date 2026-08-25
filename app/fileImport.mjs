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

export async function importPdf(file, onProgress = (progress, label) => { void progress; void label; }) {
  onProgress(0.08, "PDF 글자를 읽고 있어요…");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", document.baseURI).href;
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];

  for (let pageNo = 1; pageNo <= Math.min(document.numPages, 20); pageNo += 1) {
    onProgress(0.08 + (pageNo / document.numPages) * 0.72, `${pageNo}/${document.numPages}쪽을 읽고 있어요…`);
    const page = await document.getPage(pageNo);
    const content = await page.getTextContent();
    const positioned = content.items
      .filter((item) => "str" in item && item.str.trim())
      .map((item) => ({ value: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
      .sort((a, b) => Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x);
    const rows = [];
    for (const item of positioned) {
      const current = rows[rows.length - 1];
      if (!current || Math.abs(current.y - item.y) > 3) rows.push({ y: item.y, cells: [item.value] });
      else current.cells.push(item.value);
    }
    lines.push(...rows.map((row) => row.cells.join("\t")));
  }

  if (!lines.length) throw new Error("[V-P02] 글자가 없는 스캔 PDF입니다. PDF 페이지를 캡처해 사진으로 올려 주세요.");
  onProgress(0.9, "품목과 금액을 구분하고 있어요…");
  return parseOrderText(lines.join("\n"));
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
