"use client";

import { DragEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ImportDialog from "./ImportDialog.tsx";
import { importImage } from "./fileImport.mjs";
import { analyzePublicShoppingLink, createBookmarklet, decodeBookmarkletCapture, getShoppingLinkInfo, parseShoppingLinks } from "./linkImport.mjs";
import { chooseCapturedProductCandidate } from "./screenCapture.mjs";

type ReviewItem = {
  id: string;
  내용: string;
  규격: string;
  단위: string;
  수량: number;
  단가: number;
  _rawName: string;
  excluded: boolean;
  excludeReason?: string;
  warnings: string[];
  sourceUrl?: string;
};

type OrderMeta = {
  mall: string;
  orderNo: string;
  paidTotal: number;
  budget: number;
  stage: "pre-purchase" | "post-purchase";
  sourceUrl?: string;
  sourceUrls: string[];
  warnings: string[];
};

type LinkDraft = {
  id: string;
  sourceUrl: string;
  mall: string;
  productId: string;
  name: string;
  rawName: string;
  spec: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  lookupStatus: string;
  confidence: number;
  priceSource: string;
  notes: string[];
};

type ScreenCaptureState = {
  draftId: string | null;
  kind: "idle" | "requesting" | "recognizing" | "success" | "error";
  message: string;
  previewUrl: string | null;
};

const initialItems: ReviewItem[] = [];

const initialMeta: OrderMeta = {
  mall: "새 견적",
  orderNo: "불러오기 전",
  paidTotal: 0,
  budget: 0,
  stage: "pre-purchase",
  sourceUrls: [],
  warnings: [],
};

const warningText: Record<string, string> = {
  V02: "품명 비어 있음",
  V03: "품명 미확정",
  V04: "수량 확인 필요",
  V05: "단가 확인 필요",
  V06: "수량과 금액 불일치",
  V07: "결제 총액 불일치",
  V08: "결제 총액 확인 필요",
  V09: "캡처 OCR 결과 확인 필요",
  V10: "품목 18개 초과 · 여러 매로 분할",
  V11: "가격 기준 확인 필요",
  V12: "외화 항목 확인 필요",
  V13: "취소·반품 의심",
  V15: "예산 한도 초과",
};

const blockingRules = new Set(["V01", "V04", "V05", "V07", "V08", "V11", "V12", "V15"]);
const won = (value: number) => new Intl.NumberFormat("ko-KR").format(value);
const safeNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};
const escapeXml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

function deriveWarnings(item: ReviewItem) {
  const warnings = new Set(item.warnings);
  if (!item.내용.trim()) warnings.add("V02"); else warnings.delete("V02");
  if (!Number.isInteger(item.수량) || item.수량 < 1) warnings.add("V04"); else warnings.delete("V04");
  if (!Number.isFinite(item.단가) || item.단가 < 0) warnings.add("V05"); else warnings.delete("V05");
  return [...warnings];
}

function normalizeOrder(value: unknown): { items: ReviewItem[]; meta: OrderMeta } {
  if (!value || typeof value !== "object") throw new Error("주문 데이터 형식이 올바르지 않습니다.");
  const order = value as Record<string, unknown>;
  if (!Array.isArray(order.items) || order.items.length === 0) throw new Error("[V01] items가 비어 있습니다.");
  const stage: OrderMeta["stage"] = order.stage === "pre-purchase" ? "pre-purchase" : "post-purchase";

  const items = order.items.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const qty = safeNumber(row["수량"], 1);
    const amount = safeNumber(row["금액"], 0);
    const unitPrice = safeNumber(row["단가"], qty > 0 ? Math.round(amount / qty) : 0);
    const warnings: string[] = Array.isArray(row._warnings)
      ? row._warnings.map(String).filter((warning) => warning in warningText)
      : [];
    if (amount && qty * unitPrice !== amount) warnings.push("V06");
    const rawText = String(row._rawName ?? row._rawRow ?? row["내용"] ?? "");
    const completed = /(주문취소|취소완료|반품완료|교환완료|환불완료)/.test(rawText);
    const controls = /(취소가능|취소불가|교환\/반품 신청|반품안내)/.test(rawText);
    if (completed && !controls) warnings.push("V13");
    const item: ReviewItem = {
      id: `imported-${index}-${Date.now()}`,
      내용: String(row["내용"] ?? ""),
      규격: String(row["규격"] ?? ""),
      단위: String(row["단위"] ?? "개"),
      수량: qty,
      단가: unitPrice,
      _rawName: rawText,
      excluded: Boolean(row.excluded),
      excludeReason: row.excludeReason ? String(row.excludeReason) : undefined,
      warnings,
      sourceUrl: typeof (row.sourceUrl ?? row.url) === "string" && /^https?:\/\//.test(String(row.sourceUrl ?? row.url))
        ? String(row.sourceUrl ?? row.url)
        : undefined,
    };
    return { ...item, warnings: deriveWarnings(item) };
  });

  const primarySourceUrl = typeof order.sourceUrl === "string" && /^https?:\/\//.test(order.sourceUrl) ? order.sourceUrl : undefined;
  const sourceUrls = [...new Set([
    ...(Array.isArray(order.sourceUrls) ? order.sourceUrls.map(String) : []),
    ...(primarySourceUrl ? [primarySourceUrl] : []),
    ...items.flatMap((item) => item.sourceUrl ? [item.sourceUrl] : []),
  ].filter((url) => /^https?:\/\//.test(url)))];
  const orderWarnings = Array.isArray(order._warnings)
    ? order._warnings.map(String).filter((warning) => warning in warningText)
    : [];
  return {
    items,
    meta: {
      mall: String(order.mall ?? "불러온 주문"),
      orderNo: String(order.orderNo ?? "주문번호 없음"),
      paidTotal: stage === "pre-purchase" ? 0 : safeNumber(order.paidTotal, items.filter((item) => !item.excluded).reduce((sum, item) => sum + item.수량 * item.단가, 0)),
      budget: safeNumber(order.budget, 0),
      stage,
      sourceUrl: primarySourceUrl ?? sourceUrls[0],
      sourceUrls,
      warnings: stage === "pre-purchase" ? orderWarnings.filter((warning) => warning !== "V07" && warning !== "V08") : orderWarnings,
    },
  };
}

const u16 = (value: number) => new Uint8Array([value & 255, (value >>> 8) & 255]);
const u32 = (value: number) => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
const joinBytes = (parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => { output.set(part, offset); offset += part.length; });
  return output;
};

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: { name: string; content: string }[]) {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  files.forEach((file) => {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const checksum = crc32(data);
    const local = joinBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    const central = joinBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  });

  const localData = joinBytes(locals);
  const centralData = joinBytes(centrals);
  const end = joinBytes([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralData.length), u32(localData.length), u16(0),
  ]);
  return joinBytes([localData, centralData, end]);
}

function makeXlsx(items: ReviewItem[], meta: OrderMeta) {
  const included = items.filter((item) => !item.excluded);
  const pages = included.length
    ? Array.from({ length: Math.ceil(included.length / 18) }, (_, index) => included.slice(index * 18, index * 18 + 18))
    : [[]];
  const total = included.reduce((sum, item) => sum + item.수량 * item.단가, 0);
  const sheetFiles = pages.map((pageItems, pageIndex) => {
    const itemRows = Array.from({ length: 18 }, (_, index) => {
      const rowNo = index + 8;
      const item = pageItems[index];
      const textCell = (ref: string, value: string, style = 0) => `<c r="${ref}" t="inlineStr" s="${style}"><is><t>${escapeXml(value)}</t></is></c>`;
      const numberCell = (ref: string, value: number, style = 0) => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
      if (!item) return `<row r="${rowNo}">${textCell(`A${rowNo}`, "")}${textCell(`B${rowNo}`, "")}${textCell(`C${rowNo}`, "")}${textCell(`D${rowNo}`, "")}${textCell(`E${rowNo}`, "")}${textCell(`F${rowNo}`, "")}` +
        `<c r="G${rowNo}" s="3"><f>IF(E${rowNo}="","",E${rowNo}*F${rowNo})</f></c></row>`;
      return `<row r="${rowNo}">${numberCell(`A${rowNo}`, pageIndex * 18 + index + 1)}${textCell(`B${rowNo}`, item.내용)}${textCell(`C${rowNo}`, item.규격)}${textCell(`D${rowNo}`, item.단위)}` +
        `${numberCell(`E${rowNo}`, item.수량)}${numberCell(`F${rowNo}`, item.단가, 3)}` +
        `<c r="G${rowNo}" s="3"><f>IF(E${rowNo}="","",E${rowNo}*F${rowNo})</f><v>${item.수량 * item.단가}</v></c></row>`;
    }).join("");
    const subtotal = pageItems.reduce((sum, item) => sum + item.수량 * item.단가, 0);
    const budgetNote = meta.stage === "pre-purchase"
      ? meta.budget > 0
        ? `구매 전 예상 · 예산 ${won(meta.budget)}원 · 예상 합계 ${won(total)}원 · ${total > meta.budget ? `초과 ${won(total - meta.budget)}원` : `잔액 ${won(meta.budget - total)}원`}`
        : `구매 전 예상 · 예상 합계 ${won(total)}원`
      : "내부 품의·정리용";
    const pageNote = pages.length > 1
      ? `(총 ${pages.length}매 중 ${pageIndex + 1}매) · 전체 합계 ${won(total)}원 · ${budgetNote}`
      : `※ ${budgetNote} · 본 자료는 내부 참고용이며 원본 증빙을 대체하지 않습니다.`;
    const orderLine = pages.length > 1
      ? `주문번호 ${escapeXml(meta.orderNo)} · 총 ${pages.length}매 중 ${pageIndex + 1}매`
      : `주문번호 ${escapeXml(meta.orderNo)}`;
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G27"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="20"/>
<cols><col min="1" max="1" width="7" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/><col min="3" max="3" width="22" customWidth="1"/><col min="4" max="4" width="9" customWidth="1"/><col min="5" max="7" width="14" customWidth="1"/></cols><sheetData>
<row r="1" ht="30" customHeight="1"><c r="A1" t="inlineStr" s="1"><is><t>학교 물품구입 견적서</t></is></c></row>
<row r="3"><c r="A3" t="inlineStr" s="2"><is><t>수신</t></is></c><c r="B3" t="inlineStr"><is><t>○○초등학교장</t></is></c><c r="F3" t="inlineStr" s="2"><is><t>견적일자</t></is></c><c r="G3" t="inlineStr"><is><t>${new Date().toISOString().slice(0, 10)}</t></is></c></row>
<row r="4"><c r="A4" t="inlineStr" s="2"><is><t>건명</t></is></c><c r="B4" t="inlineStr"><is><t>${escapeXml(meta.mall)} 주문 물품 구입</t></is></c></row>
<row r="6"><c r="A6" t="inlineStr" s="4"><is><t>${orderLine}</t></is></c></row>
<row r="7"><c r="A7" t="inlineStr" s="2"><is><t>순번</t></is></c><c r="B7" t="inlineStr" s="2"><is><t>내용</t></is></c><c r="C7" t="inlineStr" s="2"><is><t>규격</t></is></c><c r="D7" t="inlineStr" s="2"><is><t>단위</t></is></c><c r="E7" t="inlineStr" s="2"><is><t>수량</t></is></c><c r="F7" t="inlineStr" s="2"><is><t>예상단가</t></is></c><c r="G7" t="inlineStr" s="2"><is><t>예상금액</t></is></c></row>
${itemRows}
<row r="26"><c r="F26" t="inlineStr" s="2"><is><t>합계</t></is></c><c r="G26" s="3"><f>SUM(G8:G25)</f><v>${subtotal}</v></c></row>
<row r="27"><c r="A27" t="inlineStr" s="4"><is><t>${escapeXml(pageNote)}</t></is></c></row>
</sheetData><mergeCells count="3"><mergeCell ref="A1:G1"/><mergeCell ref="B4:E4"/><mergeCell ref="A27:G27"/></mergeCells><pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="portrait" fitToWidth="1" fitToHeight="1"/></worksheet>`;
    return { name: `xl/worksheets/sheet${pageIndex + 1}.xml`, content: sheet };
  });

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0&quot;원&quot;"/></numFmts><fonts count="3"><font><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="18"/><color rgb="FF173027"/><name val="맑은 고딕"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF176B4D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9DED9"/></left><right style="thin"><color rgb="FFD9DED9"/></right><top style="thin"><color rgb="FFD9DED9"/></top><bottom style="thin"><color rgb="FFD9DED9"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1"/></xf></cellXfs></styleSheet>`;

  const sheetOverrides = pages.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const workbookSheets = pages.map((_, index) => `<sheet name="견적서${pages.length > 1 ? `_${index + 1}` : ""}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbookRelationships = pages.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}<Relationship Id="rId${pages.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    ...sheetFiles,
  ];
  const bytes = zipStore(files);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function captureSelectedProductScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("이 브라우저는 화면 선택 캡처를 지원하지 않습니다. 데스크톱 Chrome 또는 Edge에서 이용해 주세요.");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
  });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("선택한 상품 화면을 읽지 못했습니다."));
      video.srcObject = stream;
    });
    await video.play();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    if (!video.videoWidth || !video.videoHeight) throw new Error("선택한 화면의 크기를 확인하지 못했습니다.");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("상품 화면 이미지를 만들지 못했습니다.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("상품 화면 이미지를 만들지 못했습니다.")), "image/png"));
    return new File([blob], `상품화면_${Date.now()}.png`, { type: "image/png" });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export default function ReviewApp() {
  const [items, setItems] = useState(initialItems);
  const [meta, setMeta] = useState(initialMeta);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [message, setMessage] = useState("자동 저장됨");
  const [isImportOpen, setImportOpen] = useState(false);
  const [shoppingUrl, setShoppingUrl] = useState("");
  const [linkStatus, setLinkStatus] = useState("상품 링크를 붙여넣으면 견적 초안을 만들어요.");
  const [linkKind, setLinkKind] = useState<"idle" | "working" | "success" | "needs-confirmation" | "error">("idle");
  const [linkDrafts, setLinkDrafts] = useState<LinkDraft[]>([]);
  const [draftBudget, setDraftBudget] = useState("");
  const [draftError, setDraftError] = useState("");
  const [bookmarklet, setBookmarklet] = useState("");
  const [screenCapture, setScreenCapture] = useState<ScreenCaptureState>({ draftId: null, kind: "idle", message: "", previewUrl: null });
  const bookmarkRef = useRef<HTMLAnchorElement>(null);
  const capturePreviewRef = useRef<string | null>(null);

  const totals = useMemo(() => {
    const included = items.filter((item) => !item.excluded);
    const total = included.reduce((sum, item) => sum + item.수량 * item.단가, 0);
    const warnings = [...meta.warnings, ...items.flatMap((item) => item.warnings)];
    if (meta.stage === "post-purchase" && meta.paidTotal && meta.paidTotal !== total) warnings.push("V07");
    if (meta.stage === "pre-purchase" && meta.budget > 0 && total > meta.budget) warnings.push("V15");
    if (included.length > 18) warnings.push("V10");
    const comparison = meta.stage === "pre-purchase" ? meta.budget : meta.paidTotal;
    return { total, delta: comparison - total, warnings, included };
  }, [items, meta.budget, meta.paidTotal, meta.stage, meta.warnings]);

  const visibleItems = issuesOnly ? items.filter((item) => item.warnings.length > 0) : items;
  const hasBlock = totals.warnings.some((warning) => blockingRules.has(warning));
  const hasItems = items.length > 0;
  const normalizedShoppingUrl = useMemo(() => {
    try { return parseShoppingLinks(shoppingUrl)[0] ?? ""; } catch { return ""; }
  }, [shoppingUrl]);
  const draftTotal = useMemo(() => linkDrafts.reduce((sum, draft) => sum + draft.quantity * draft.unitPrice, 0), [linkDrafts]);

  const updateItem = (id: string, patch: Partial<ReviewItem>) => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const nextItem = { ...item, ...patch };
      return { ...nextItem, warnings: deriveWarnings(nextItem) };
    }));
    setMessage("변경 내용 저장 중…");
    window.setTimeout(() => setMessage("자동 저장됨"), 450);
  };

  const applyOrder = useCallback((value: unknown, label: string) => {
    try {
      const normalized = normalizeOrder(value);
      setItems(normalized.items);
      setMeta(normalized.meta);
      setIssuesOnly(false);
      setMessage(`${label} 불러옴`);
      setImportOpen(false);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "주문내역을 불러오지 못했습니다.";
    }
  }, []);

  useEffect(() => {
    const value = createBookmarklet(window.location.origin);
    setBookmarklet(value);
    bookmarkRef.current?.setAttribute("href", value);
  }, []);

  useEffect(() => {
    if (!window.location.hash.startsWith("#quote-import=")) return;
    try {
      const order = decodeBookmarkletCapture(window.location.hash);
      if (order) {
        const error = applyOrder(order, "쇼핑몰 화면");
        if (error) throw new Error(error);
        setShoppingUrl(String((order as { sourceUrl?: string }).sourceUrl ?? ""));
        setLinkKind("success");
        setLinkStatus((order as { _extractedBy?: string })._extractedBy === "single-product-page"
          ? "상품명과 공개 판매가를 가져왔어요. 수량·옵션·최종 결제금액을 확인해 주세요."
          : "쇼핑몰 화면에서 상품 카드와 원본 링크를 가져왔어요.");
      }
    } catch (error) {
      setLinkKind("error");
      setLinkStatus(error instanceof Error ? error.message : "쇼핑몰 화면을 불러오지 못했습니다.");
    } finally {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, [applyOrder]);

  useEffect(() => () => {
    if (capturePreviewRef.current) URL.revokeObjectURL(capturePreviewRef.current);
  }, []);

  const analyzeShoppingLink = async () => {
    setLinkKind("working");
    setLinkDrafts([]);
    setDraftError("");
    setLinkStatus("상품번호와 공개 가격의 출처를 확인하고 있어요…");
    try {
      const links = parseShoppingLinks(shoppingUrl);
      setShoppingUrl(links.join("\n"));
      const allDrafts: LinkDraft[] = [];
      for (let offset = 0; offset < links.length; offset += 4) {
        const batch = await Promise.all(links.slice(offset, offset + 4).map(async (sourceUrl, batchIndex) => {
          const linkIndex = offset + batchIndex;
          const linkInfo = getShoppingLinkInfo(sourceUrl);
          if (linkInfo.kind === "gmarket-product") {
            let payload: { name?: string; price?: number; lookupStatus?: string; confidence?: number; source?: string; notes?: string[] } = {};
            try {
              const response = await fetch(`/api/product-draft?mall=gmarket&productId=${encodeURIComponent(linkInfo.productId)}`, { headers: { Accept: "application/json" } });
              if (response.ok) payload = await response.json();
            } catch { /* 상품번호를 보존한 빈 초안으로 계속 진행 */ }
            const name = String(payload.name ?? "");
            return [{
              id: `link-${linkIndex}-0-${Date.now()}`,
              sourceUrl: linkInfo.sourceUrl,
              mall: "G마켓",
              productId: linkInfo.productId,
              name,
              rawName: name,
              spec: "",
              unit: "개",
              quantity: 1,
              unitPrice: safeNumber(payload.price, 0),
              lookupStatus: String(payload.lookupStatus ?? "confirmation-required"),
              confidence: Number(payload.confidence ?? 0),
              priceSource: String(payload.source ?? "확인 필요"),
              notes: Array.isArray(payload.notes) ? payload.notes.map(String) : ["원본 상품 화면을 보며 상품명과 예상단가를 확인하세요."],
            } satisfies LinkDraft];
          }

          try {
            const order = await analyzePublicShoppingLink(sourceUrl) as { mall?: string; items?: Array<Record<string, unknown>> };
            return (order.items ?? []).map((row, itemIndex) => {
              const warnings = Array.isArray(row._warnings) ? row._warnings.map(String) : [];
              const name = String(row["내용"] ?? "");
              return {
                id: `link-${linkIndex}-${itemIndex}-${Date.now()}`,
                sourceUrl,
                mall: String(order.mall ?? new URL(sourceUrl).hostname.replace(/^www\./, "")),
                productId: (order.items?.length ?? 0) > 1 ? `링크 ${linkIndex + 1} · 품목 ${itemIndex + 1}` : `상품 링크 ${linkIndex + 1}`,
                name,
                rawName: String(row._rawName ?? name),
                spec: String(row["규격"] ?? ""),
                unit: String(row["단위"] ?? "개"),
                quantity: safeNumber(row["수량"], 1),
                unitPrice: safeNumber(row["단가"], 0),
                lookupStatus: "found",
                confidence: warnings.length ? 0.65 : 0.8,
                priceSource: "공개 상품 페이지",
                notes: warnings.map((warning) => `${warning} ${warningText[warning] ?? "확인 필요"}`),
              } satisfies LinkDraft;
            });
          } catch {
            const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
            return [{
              id: `link-${linkIndex}-0-${Date.now()}`,
              sourceUrl,
              mall: host,
              productId: `상품 링크 ${linkIndex + 1}`,
              name: "",
              rawName: "",
              spec: "",
              unit: "개",
              quantity: 1,
              unitPrice: 0,
              lookupStatus: "confirmation-required",
              confidence: 0,
              priceSource: "확인 필요",
              notes: ["쇼핑몰이 공개 조회를 막았습니다. 원본을 보며 빈칸을 확인하세요."],
            } satisfies LinkDraft];
          }
        }));
        batch.forEach((drafts) => allDrafts.push(...drafts));
      }
      setLinkDrafts(allDrafts);
      const ready = allDrafts.filter((draft) => draft.name && draft.unitPrice > 0).length;
      setLinkKind(ready === allDrafts.length ? "success" : "needs-confirmation");
      setLinkStatus(`${links.length}개 링크에서 ${allDrafts.length}개 상품 초안을 만들었어요. ${allDrafts.length - ready}개는 빈칸 확인이 필요합니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "링크를 읽지 못했습니다.";
      setLinkKind("error");
      setLinkStatus(message);
    }
  };

  const updateLinkDraft = (id: string, patch: Partial<LinkDraft>) => {
    setLinkDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
    setDraftError("");
  };

  const fillDraftFromProductScreen = async (draft: LinkDraft) => {
    setDraftError("");
    if (capturePreviewRef.current) URL.revokeObjectURL(capturePreviewRef.current);
    capturePreviewRef.current = null;
    setScreenCapture({
      draftId: draft.id,
      kind: "requesting",
      message: "브라우저 창에서 상품이 열린 탭을 선택하고 ‘공유’를 눌러 주세요.",
      previewUrl: null,
    });
    try {
      const file = await captureSelectedProductScreen();
      if (capturePreviewRef.current) URL.revokeObjectURL(capturePreviewRef.current);
      const previewUrl = URL.createObjectURL(file);
      capturePreviewRef.current = previewUrl;
      setScreenCapture({ draftId: draft.id, kind: "recognizing", message: "화면 공유를 종료했어요. 상품명과 판매가를 읽고 있습니다…", previewUrl });
      const order = await importImage(file, (progress: number, label: string) => {
        setScreenCapture({ draftId: draft.id, kind: "recognizing", message: `${label} ${Math.round(progress * 100)}%`, previewUrl });
      }) as { items?: Array<Record<string, unknown>> };
      const candidate = chooseCapturedProductCandidate(order.items, draft.name);
      updateLinkDraft(draft.id, {
        name: candidate.name,
        rawName: candidate.rawName,
        unitPrice: candidate.unitPrice,
        lookupStatus: "screen-captured",
        confidence: 0.6,
        priceSource: "선택한 상품 화면 OCR",
        notes: [
          `화면에서 ${candidate.candidateCount}개 가격 후보를 비교해 가장 가능성 높은 값을 채웠습니다.`,
          "상품명·선택 옵션·판매가를 원본과 한 번 확인해 주세요.",
        ],
      });
      setLinkKind("needs-confirmation");
      setLinkStatus("상품 화면에서 상품명과 예상단가를 채웠어요. 선택 옵션과 판매가를 원본과 대조해 주세요.");
      setScreenCapture({ draftId: draft.id, kind: "success", message: "상품명과 예상단가를 채웠어요. 원본 화면과 한 번만 대조해 주세요.", previewUrl });
    } catch (error) {
      const cancelled = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
      setScreenCapture({
        draftId: draft.id,
        kind: "error",
        message: cancelled
          ? "화면 선택이 취소됐어요. 다시 누른 뒤 G마켓 상품 탭을 선택해 주세요."
          : error instanceof Error ? error.message : "상품 화면을 가져오지 못했습니다.",
        previewUrl: capturePreviewRef.current,
      });
    }
  };

  const addLinkDrafts = () => {
    if (!linkDrafts.length) return;
    const invalidIndex = linkDrafts.findIndex((draft) => !draft.name.trim() || !Number.isInteger(draft.quantity) || draft.quantity < 1 || draft.unitPrice < 1);
    if (invalidIndex >= 0) {
      const draft = linkDrafts[invalidIndex];
      const field = !draft.name.trim() ? "상품명" : draft.quantity < 1 ? "수량" : "예상단가";
      setDraftError(`${invalidIndex + 1}번 상품의 ${field}을(를) 확인해 주세요.`);
      return;
    }
    const budget = safeNumber(draftBudget, 0);
    const error = applyOrder({
      mall: linkDrafts.length > 1 ? "여러 쇼핑몰" : linkDrafts[0].mall,
      stage: "pre-purchase",
      budget,
      paidTotal: null,
      sourceUrl: linkDrafts[0].sourceUrl,
      sourceUrls: linkDrafts.map((draft) => draft.sourceUrl),
      orderNo: `상품 링크 ${linkDrafts.length}개`,
      _warnings: [],
      _extractedBy: "confirmed-link-list",
      items: linkDrafts.map((draft) => ({
        내용: draft.name.trim(),
        규격: draft.spec.trim(),
        단위: draft.unit.trim() || "개",
        수량: draft.quantity,
        단가: draft.unitPrice,
        금액: draft.quantity * draft.unitPrice,
        _rawName: draft.rawName || draft.name,
        sourceUrl: draft.sourceUrl,
        _warnings: [],
        excluded: false,
      })),
    }, "상품 링크 목록");
    if (error) { setDraftError(error); return; }
    setLinkKind("success");
    setLinkStatus(`${linkDrafts.length}개 상품을 구매 전 검수표에 추가했어요. 예산 한도와 예상 합계를 확인해 주세요.`);
  };

  const dragBookmarklet = (event: DragEvent<HTMLAnchorElement>) => {
    if (!bookmarklet) return;
    event.dataTransfer.setData("text/uri-list", bookmarklet);
    event.dataTransfer.setData("text/plain", bookmarklet);
    event.dataTransfer.effectAllowed = "copyLink";
  };

  const explainBookmarklet = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setLinkKind("needs-confirmation");
    setLinkStatus("현재 화면 보내기는 로그인 주문을 한꺼번에 가져올 때만 쓰는 고급 기능입니다.");
  };

  const saveReview = () => {
    const reviewed = {
      mall: meta.mall,
      orderNo: meta.orderNo,
      paidTotal: meta.paidTotal,
      budget: meta.budget,
      stage: meta.stage,
      sourceUrl: meta.sourceUrl,
      sourceUrls: meta.sourceUrls,
      reviewedAt: new Date().toISOString(),
      items: items.map((item) => ({
        내용: item.내용,
        규격: item.규격,
        단위: item.단위,
        수량: item.수량,
        단가: item.단가,
        금액: item.수량 * item.단가,
        _rawName: item._rawName,
        sourceUrl: item.sourceUrl,
        excluded: item.excluded,
        ...(item.excludeReason ? { excludeReason: item.excludeReason } : {}),
      })),
    };
    download(new Blob([JSON.stringify(reviewed, null, 2)], { type: "application/json;charset=utf-8" }), "order.reviewed.json");
    setMessage("검수 내용을 저장했어요");
  };

  const createEstimate = () => {
    if (hasBlock || totals.included.length === 0) return;
    download(makeXlsx(items, meta), `견적서_${meta.orderNo}.xlsx`);
    setMessage("견적서를 만들었어요");
  };

  return (
    <main className="app-shell">
      {isImportOpen && <ImportDialog onClose={() => setImportOpen(false)} onImport={applyOrder} />}
      <header className="topbar">
        <a className="brand" href="#top" aria-label="견적정리 홈"><span className="brand-mark" aria-hidden="true">견</span><span>견적정리</span></a>
        <div className="stepper" aria-label="진행 단계"><span className={`step ${hasItems ? "done" : "active"}`}><b>1</b> 링크·파일 불러오기</span><span className={`step ${hasItems ? "active" : ""}`}><b>2</b> 내용 확인·수정</span><span className="step"><b>3</b> 엑셀 다운로드</span><span className="step"><b>4</b> K-에듀파인 등록</span></div>
        <button className="ghost-button" type="button" onClick={() => setImportOpen(true)}>주문내역 가져오기</button>
      </header>

      <section className="workspace" id="top">
        <section className="quick-start" aria-labelledby="quick-start-title">
          <div className="quick-start-copy"><span>STEP 1 · 구매 전 품의</span><h2 id="quick-start-title">상품 링크를 한 줄에 하나씩 붙여넣으세요</h2><p>최대 20개 링크의 상품명·공개 가격과 출처를 확인하고, 수량과 예산 한도만 검수합니다.</p></div>
          <form className="link-import-form" onSubmit={(event) => { event.preventDefault(); void analyzeShoppingLink(); }}>
            <label htmlFor="shopping-url">쇼핑몰 상품 링크 · 여러 개 가능</label>
            <div><textarea id="shopping-url" value={shoppingUrl} onChange={(event) => { setShoppingUrl(event.target.value); setLinkDrafts([]); setDraftError(""); setLinkKind("idle"); setLinkStatus("상품 링크를 붙여넣으면 견적 초안을 만들어요."); }} placeholder={"https://…/상품1\nhttps://…/상품2"} rows={Math.min(Math.max(shoppingUrl.split(/\r?\n/).length, 2), 6)} autoComplete="url" /><button type="submit" disabled={!shoppingUrl.trim() || linkKind === "working"}>{linkKind === "working" ? "확인 중…" : "상품 초안 만들기"}</button></div>
          </form>
          <div className={`link-status ${linkKind}`} aria-live="polite"><span aria-hidden="true" />{linkStatus}</div>
          {linkDrafts.some((draft) => !draft.name || draft.unitPrice < 1) && (
            <div className="screen-capture-guide">
              <span className="screen-capture-guide-icon" aria-hidden="true">▣</span>
              <div><strong>G마켓처럼 링크 조회가 막혀도 화면에서 채울 수 있어요</strong><p>아래에서 <b>원본 화면 열기</b>로 상품을 띄운 뒤 <b>상품 화면 선택</b>을 누르고, 표시되는 창에서 그 상품 탭을 선택하세요.</p></div>
              <em>설치 없음</em>
            </div>
          )}
          {linkDrafts.length > 0 && (
            <section className="link-draft-card" aria-labelledby="link-draft-title">
              <div className="link-draft-heading">
                <div><span className="mall-badge">상품 초안 · {linkDrafts.length}개</span><h3 id="link-draft-title">가격 출처와 빈칸만 확인해 주세요</h3><p>수량은 링크에 없으므로 1로 시작합니다. 실제 구입 수량과 선택 옵션 가격으로 수정하세요.</p></div>
              </div>
              <div className="link-draft-list">
                {linkDrafts.map((draft, index) => (
                  <article className="link-draft-item" key={draft.id} aria-labelledby={`link-draft-${index}`}>
                    <div className="draft-item-heading"><div><span>{index + 1}</span><strong id={`link-draft-${index}`}>{draft.mall} · {draft.productId}</strong><em className={draft.confidence >= .8 ? "high" : draft.confidence >= .6 ? "medium" : "low"}>{draft.confidence ? `가격 신뢰도 ${Math.round(draft.confidence * 100)}%` : "직접 확인"}</em></div><div className="draft-item-actions"><a href={draft.sourceUrl} target="_blank" rel="noreferrer">원본 화면 열기 ↗</a><button type="button" onClick={() => void fillDraftFromProductScreen(draft)} disabled={screenCapture.kind === "requesting" || screenCapture.kind === "recognizing"}>{screenCapture.draftId === draft.id && (screenCapture.kind === "requesting" || screenCapture.kind === "recognizing") ? "읽는 중…" : "상품 화면 선택"}</button></div></div>
                    {screenCapture.draftId === draft.id && screenCapture.kind !== "idle" && (
                      <div className={`screen-capture-result ${screenCapture.kind}`} role="status" aria-live="polite">
                        {screenCapture.previewUrl && <img src={screenCapture.previewUrl} alt="선택한 상품 화면 미리보기" />}
                        <div><strong>{screenCapture.kind === "requesting" ? "1. 상품 탭 선택" : screenCapture.kind === "recognizing" ? "2. 상품 정보 자동 인식" : screenCapture.kind === "success" ? "3. 자동 채우기 완료" : "다시 시도해 주세요"}</strong><p>{screenCapture.message}</p></div>
                      </div>
                    )}
                    <div className="link-draft-grid">
                      <label className="draft-name">내용 <b>필수</b><input value={draft.name} onChange={(event) => updateLinkDraft(draft.id, { name: event.target.value })} placeholder="상품명을 입력하세요" /></label>
                      <label>규격·옵션 <b>선택</b><input value={draft.spec} onChange={(event) => updateLinkDraft(draft.id, { spec: event.target.value })} placeholder="예: 250mL · 파란색" /></label>
                      <label>단위 <b>필수</b><input value={draft.unit} onChange={(event) => updateLinkDraft(draft.id, { unit: event.target.value })} placeholder="개" /></label>
                      <label>수량 <b>필수</b><input type="number" min="1" step="1" value={draft.quantity} onChange={(event) => updateLinkDraft(draft.id, { quantity: safeNumber(event.target.value, 1) })} /></label>
                      <label>예상단가 <b>필수</b><span className="money-field"><input type="number" min="0" step="1" value={draft.unitPrice || ""} onChange={(event) => updateLinkDraft(draft.id, { unitPrice: safeNumber(event.target.value) })} placeholder="0" /><i>원</i></span></label>
                      <div className="draft-amount"><span>예상금액</span><strong>{won(draft.quantity * draft.unitPrice)}원</strong></div>
                    </div>
                    <div className="draft-provenance"><span>가격 출처 · {draft.priceSource}</span>{draft.notes.map((note) => <p key={note}>{note}</p>)}</div>
                  </article>
                ))}
              </div>
              <div className="link-draft-footer">
                <label className="draft-budget">예산 한도 <b>선택</b><span className="money-field"><input type="number" min="0" step="1" value={draftBudget} onChange={(event) => { setDraftBudget(event.target.value); setDraftError(""); }} placeholder="예: 300000" /><i>원</i></span></label>
                <div><span>예상 합계</span><strong>{won(draftTotal)}원</strong><small>{draftBudget && safeNumber(draftBudget) < draftTotal ? `예산보다 ${won(draftTotal - safeNumber(draftBudget))}원 초과` : "수량 × 예상단가"}</small></div>
                <button type="button" onClick={addLinkDrafts}>확인한 {linkDrafts.length}개를 검수표에 추가</button>
              </div>
              {draftError && <p className="draft-error" role="alert">{draftError}</p>}
            </section>
          )}
          <div className="quick-start-fallback"><span>여러 상품이 있는 장바구니·주문이라면</span><button type="button" onClick={() => setImportOpen(true)}>PDF·엑셀·캡처 올리기</button><button type="button" onClick={() => setImportOpen(true)}>주문 화면 직접 붙여넣기</button></div>
          <details className="advanced-link-tool">
            <summary>고급 기능 · 로그인 주문 화면을 한꺼번에 가져오기</summary>
            <div><p>여러 상품을 파일로 받을 수 없을 때만 사용합니다. 북마크바 등록이 필요하므로 일반 상품 링크에는 위의 ‘상품 초안 만들기’를 권장합니다.</p><div className="login-link-actions"><a className={!normalizedShoppingUrl ? "disabled" : ""} href={normalizedShoppingUrl || "#"} target={normalizedShoppingUrl ? "_blank" : undefined} rel="noreferrer" onClick={(event) => { if (!normalizedShoppingUrl) event.preventDefault(); }}>쇼핑몰 링크 열기</a><a ref={bookmarkRef} className="bookmarklet-button" href="#" draggable onDragStart={dragBookmarklet} onClick={explainBookmarklet}>현재 화면 보내기 ↗</a></div></div>
          </details>
        </section>
        {hasItems ? <>
        <div className="page-heading">
          <div>
            <p className="eyebrow">{meta.mall} · {meta.stage === "pre-purchase" ? "구매 전 예상 견적" : `주문 ${meta.orderNo}`}</p>
            <h1>내역을 한 번 더<br />확인해 주세요.</h1>
            <p className="heading-copy">기계가 옮겨 적고, 선생님이 판단합니다.<br />{meta.stage === "pre-purchase" ? "수량·예상단가와 예산 한도를 확인하세요." : "노란 표시만 확인하면 견적서가 완성돼요."}</p>
            {meta.sourceUrl && <a className="source-link" href={meta.sourceUrl} target="_blank" rel="noreferrer">{meta.sourceUrls.length > 1 ? `첫 번째 원본 상품 열기 · 총 ${meta.sourceUrls.length}개` : "원본 주문내역 열기"} <span aria-hidden="true">↗</span></a>}
          </div>
          <div className="summary-card" aria-label="합계 요약">
            <div className="summary-topline"><span>{meta.stage === "pre-purchase" ? "예산 한도" : "결제 총액"}</span><label className="paid-total-input"><input type="number" min="0" step="1" value={meta.stage === "pre-purchase" ? meta.budget || "" : meta.paidTotal} onChange={(event) => setMeta((current) => current.stage === "pre-purchase" ? { ...current, budget: safeNumber(event.target.value) } : { ...current, paidTotal: safeNumber(event.target.value), warnings: current.warnings.filter((warning) => warning !== "V08") })} aria-label={meta.stage === "pre-purchase" ? "예산 한도" : "결제 총액"} placeholder={meta.stage === "pre-purchase" ? "입력 선택" : undefined} /><b>원</b></label></div>
            <div className="summary-metric"><span>{meta.stage === "pre-purchase" ? "구매 예상 합계" : "포함 품목 합계"}</span><b>{won(totals.total)}원</b></div>
            {meta.stage === "pre-purchase"
              ? meta.budget === 0
                ? <div className="match-pill neutral"><span aria-hidden="true">i</span> 예산을 입력하면 초과 여부를 확인해요</div>
                : totals.delta >= 0
                  ? <div className="match-pill"><span aria-hidden="true">✓</span> 예산 잔액 {won(totals.delta)}원</div>
                  : <div className="match-pill mismatch"><span aria-hidden="true">!</span> 예산보다 {won(-totals.delta)}원 초과</div>
              : totals.delta === 0
                ? <div className="match-pill"><span aria-hidden="true">✓</span> 결제 금액과 정확히 일치해요</div>
                : <div className="match-pill mismatch"><span aria-hidden="true">!</span> 차액 {totals.delta > 0 ? "+" : ""}{won(totals.delta)}원</div>}
          </div>
        </div>

        <div className="review-card">
          <div className="notice" role="status">
            <div className="notice-icon" aria-hidden="true">!</div>
            <div><strong>확인할 항목이 {totals.warnings.length}개 있어요</strong><p>{[...new Set(totals.warnings)].map((id) => `${id} ${warningText[id] ?? "확인 필요"}`).join(" · ") || "모든 항목을 확인했습니다."}</p></div>
            <button className={issuesOnly ? "selected" : ""} type="button" onClick={() => setIssuesOnly((value) => !value)}>{issuesOnly ? "모든 항목 보기" : "확인 항목만 보기"}</button>
          </div>

          <div className="table-toolbar">
            <div><h2>품목 {items.length}개</h2><p>포함 여부와 내용을 바꾸면 합계가 바로 갱신됩니다.</p></div>
            <span className="autosave" aria-live="polite"><i aria-hidden="true" /> {message}</span>
          </div>

          <div className="quote-table" role="table" aria-label="견적 품목 검수">
            <div className="quote-row table-head" role="row"><span role="columnheader">순번</span><span role="columnheader">내용</span><span role="columnheader">규격</span><span role="columnheader">단위</span><span role="columnheader">수량</span><span role="columnheader">예상단가</span><span role="columnheader">예상금액</span></div>
            {visibleItems.map((item) => (
              <div className={`quote-row ${item.warnings.length ? "needs-check" : ""} ${item.excluded ? "is-excluded" : ""}`} role="row" key={item.id}>
                <span className="sequence-cell" role="cell"><input className="real-check" type="checkbox" checked={!item.excluded} onChange={(event) => updateItem(item.id, { excluded: !event.target.checked, excludeReason: event.target.checked ? undefined : item.excludeReason ?? "검수에서 제외" })} aria-label={`${item.내용} 견적서 포함`} /><b>{items.findIndex((candidate) => candidate.id === item.id) + 1}</b></span>
                <span className="name-cell" role="cell">
                  <span className="item-line"><input className="cell-input name-input" value={item.내용} onChange={(event) => updateItem(item.id, { 내용: event.target.value, warnings: item.warnings.filter((warning) => warning !== "V03") })} aria-label={`${item.내용} 품명`} />{item.warnings.map((warning) => <em key={warning}>{warning}</em>)}</span>
                  <small title={item._rawName}>{item._rawName}</small>
                  {item.sourceUrl && <a className="item-source-link" href={item.sourceUrl} target="_blank" rel="noreferrer">원본 상품 ↗</a>}
                  {item.excluded && <span className="exclude-note">제외 사유 · {item.excludeReason ?? "검수에서 제외"}</span>}
                </span>
                <span role="cell"><input className="cell-input" value={item.규격} onChange={(event) => updateItem(item.id, { 규격: event.target.value })} aria-label={`${item.내용} 규격`} /></span>
                <span role="cell"><input className="cell-input unit-input" value={item.단위} onChange={(event) => updateItem(item.id, { 단위: event.target.value })} aria-label={`${item.내용} 단위`} /></span>
                <span role="cell"><input className="cell-input numeric-input" type="number" min="1" step="1" value={item.수량} onChange={(event) => updateItem(item.id, { 수량: safeNumber(event.target.value), warnings: item.warnings.filter((warning) => warning !== "V04" && warning !== "V06") })} aria-label={`${item.내용} 수량`} /></span>
                <span className="number" role="cell"><input className="cell-input price-input" type="number" min="0" step="1" value={item.단가} onChange={(event) => updateItem(item.id, { 단가: safeNumber(event.target.value), warnings: item.warnings.filter((warning) => warning !== "V05" && warning !== "V06" && warning !== "V11") })} aria-label={`${item.내용} 예상단가`} /></span>
                <span className="number amount" role="cell">{won(item.수량 * item.단가)}</span>
              </div>
            ))}
          </div>

          <div className="card-footer">
            <p><span aria-hidden="true">ⓘ</span> 내부 품의·정리용입니다. 원본 증빙은 별도로 보관해 주세요.</p>
            <div className="footer-actions"><button className="secondary-button" type="button" onClick={saveReview}>검수 내용 저장</button><button className="primary-button" type="button" onClick={createEstimate} disabled={hasBlock || totals.included.length === 0}>견적서 생성 <span aria-hidden="true">→</span></button></div>
          </div>
        </div>
        </> : (
          <section className="empty-review" aria-label="불러온 품목 없음">
            <span className="empty-review-icon" aria-hidden="true">▤</span>
            <h2>아직 불러온 품목이 없어요</h2>
            <p>위에 상품 링크를 한 줄에 하나씩 붙여넣거나 PDF, 엑셀 견적서, 장바구니 캡처를 올려 주세요.</p>
            <button type="button" onClick={() => setImportOpen(true)}>파일이나 주문 화면으로 시작하기</button>
          </section>
        )}

        <section className="help-stack" aria-label="가져오기 도움말">
          <details>
            <summary><span>정확하게 가져오는 권장 순서</span><b>+</b></summary>
            <div><p><strong>후보 상품</strong> 최대 20개 링크를 한 줄에 하나씩 붙여넣고 가격 출처·신뢰도·수량을 확인합니다.</p><p><strong>장바구니</strong> 쇼핑몰에서 내려받은 엑셀·PDF를 올립니다. 파일이 없으면 글자를 크게 확대한 장바구니 캡처를 사용하세요.</p><p><strong>예산 확인</strong> 구매 전에는 결제 총액이 없어도 오류가 아닙니다. 예산 한도를 입력하면 <strong>V15</strong>로 초과 여부를 확인합니다.</p></div>
          </details>
          <details>
            <summary><span>왜 주문 화면 붙여넣기는 보조 기능인가요?</span><b>+</b></summary>
            <div><p>복사된 텍스트에는 상품 카드의 경계와 ‘단가·합계’ 의미가 사라질 수 있습니다. 그래서 수량이나 가격 기준을 확인할 수 없는 값은 <strong>V04·V11</strong>로 표시하고, 확인 전에는 엑셀 생성을 막습니다.</p></div>
          </details>
          <details>
            <summary><span>K-에듀파인 등록 전 확인</span><b>+</b></summary>
            <div><p>순번·내용·규격·단위·수량·예상단가·예상금액과 원본 주문의 결제 총액을 대조하세요. 생성 파일은 내부 품의·정리용이며 원본 증빙을 대신하지 않습니다.</p></div>
          </details>
        </section>
      </section>
    </main>
  );
}
