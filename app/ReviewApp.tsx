"use client";

import { DragEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ImportDialog from "./ImportDialog.tsx";
import { analyzePublicShoppingLink, createBookmarklet, decodeBookmarkletCapture, getShoppingLinkInfo, normalizeShoppingUrl } from "./linkImport.mjs";

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
};

type OrderMeta = {
  mall: string;
  orderNo: string;
  paidTotal: number;
  sourceUrl?: string;
  warnings: string[];
};

type LinkDraft = {
  sourceUrl: string;
  mall: string;
  productId: string;
  name: string;
  spec: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  paidTotal: string;
  lookupStatus: string;
};

const initialItems: ReviewItem[] = [];

const initialMeta: OrderMeta = {
  mall: "새 견적",
  orderNo: "불러오기 전",
  paidTotal: 0,
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
};

const blockingRules = new Set(["V01", "V04", "V05", "V07", "V08", "V11", "V12"]);
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
    };
    return { ...item, warnings: deriveWarnings(item) };
  });

  return {
    items,
    meta: {
      mall: String(order.mall ?? "불러온 주문"),
      orderNo: String(order.orderNo ?? "주문번호 없음"),
      paidTotal: safeNumber(order.paidTotal, items.filter((item) => !item.excluded).reduce((sum, item) => sum + item.수량 * item.단가, 0)),
      sourceUrl: typeof order.sourceUrl === "string" && /^https?:\/\//.test(order.sourceUrl) ? order.sourceUrl : undefined,
      warnings: Array.isArray(order._warnings)
        ? order._warnings.map(String).filter((warning) => warning in warningText)
        : [],
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
    const pageNote = pages.length > 1
      ? `(총 ${pages.length}매 중 ${pageIndex + 1}매) · 전체 합계 ${won(total)}원 · 내부 품의·정리용`
      : "※ 본 자료는 내부 품의·정리용이며 원본 증빙을 대체하지 않습니다.";
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

export default function ReviewApp() {
  const [items, setItems] = useState(initialItems);
  const [meta, setMeta] = useState(initialMeta);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [message, setMessage] = useState("자동 저장됨");
  const [isImportOpen, setImportOpen] = useState(false);
  const [shoppingUrl, setShoppingUrl] = useState("");
  const [linkStatus, setLinkStatus] = useState("상품 링크를 붙여넣으면 견적 초안을 만들어요.");
  const [linkKind, setLinkKind] = useState<"idle" | "working" | "success" | "needs-confirmation" | "error">("idle");
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const [bookmarklet, setBookmarklet] = useState("");
  const bookmarkRef = useRef<HTMLAnchorElement>(null);

  const totals = useMemo(() => {
    const included = items.filter((item) => !item.excluded);
    const total = included.reduce((sum, item) => sum + item.수량 * item.단가, 0);
    const warnings = [...meta.warnings, ...items.flatMap((item) => item.warnings)];
    if (meta.paidTotal && meta.paidTotal !== total) warnings.push("V07");
    if (included.length > 18) warnings.push("V10");
    return { total, delta: meta.paidTotal - total, warnings, included };
  }, [items, meta.paidTotal, meta.warnings]);

  const visibleItems = issuesOnly ? items.filter((item) => item.warnings.length > 0) : items;
  const hasBlock = totals.warnings.some((warning) => blockingRules.has(warning));
  const hasItems = items.length > 0;
  const normalizedShoppingUrl = useMemo(() => {
    try { return normalizeShoppingUrl(shoppingUrl); } catch { return ""; }
  }, [shoppingUrl]);
  const shoppingLinkInfo = useMemo(() => {
    try { return getShoppingLinkInfo(shoppingUrl); } catch { return null; }
  }, [shoppingUrl]);

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

  const analyzeShoppingLink = async () => {
    setLinkKind("working");
    setLinkDraft(null);
    setDraftError("");
    setLinkStatus("상품번호와 공개된 상품 정보를 확인하고 있어요…");
    try {
      if (shoppingLinkInfo?.kind === "gmarket-product") {
        setShoppingUrl(shoppingLinkInfo.sourceUrl);
        const response = await fetch(`/api/product-draft?mall=gmarket&productId=${encodeURIComponent(shoppingLinkInfo.productId)}`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("상품 링크 형식을 확인해 주세요.");
        const payload = await response.json() as { name?: string; price?: number; lookupStatus?: string };
        const name = String(payload.name ?? "");
        const unitPrice = safeNumber(payload.price, 0);
        setLinkDraft({
          sourceUrl: shoppingLinkInfo.sourceUrl,
          mall: "G마켓",
          productId: shoppingLinkInfo.productId,
          name,
          spec: "",
          unit: "개",
          quantity: 1,
          unitPrice,
          paidTotal: "",
          lookupStatus: String(payload.lookupStatus ?? "confirmation-required"),
        });
        const found = Boolean(name && unitPrice);
        setLinkKind(found ? "success" : "needs-confirmation");
        setLinkStatus(found
          ? "상품명과 공개 판매가를 채웠어요. 수량·옵션·실제 단가만 확인해 주세요."
          : `G마켓 상품번호 ${shoppingLinkInfo.productId}을 확인했어요. 링크에서 확인되지 않은 값만 입력해 주세요.`);
        return;
      }
      const order = await analyzePublicShoppingLink(shoppingUrl);
      const error = applyOrder(order, "쇼핑몰 링크");
      if (error) throw new Error(error);
      setLinkKind("success");
      setLinkStatus("링크에서 구조화된 상품 정보를 가져왔어요. 금액을 검수해 주세요.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "링크를 읽지 못했습니다.";
      if (normalizedShoppingUrl) {
        const url = new URL(normalizedShoppingUrl);
        setLinkDraft({
          sourceUrl: normalizedShoppingUrl,
          mall: url.hostname.replace(/^www\./, ""),
          productId: "상품 링크",
          name: "",
          spec: "",
          unit: "개",
          quantity: 1,
          unitPrice: 0,
          paidTotal: "",
          lookupStatus: "confirmation-required",
        });
        setLinkKind("needs-confirmation");
        setLinkStatus("외부에서 읽지 못한 값만 입력하면 견적 초안을 만들 수 있어요.");
      } else {
        setLinkKind("error");
        setLinkStatus(message);
      }
    }
  };

  const updateLinkDraft = (patch: Partial<LinkDraft>) => {
    setLinkDraft((current) => current ? { ...current, ...patch } : current);
    setDraftError("");
  };

  const addLinkDraft = () => {
    if (!linkDraft) return;
    const name = linkDraft.name.trim();
    const quantity = safeNumber(linkDraft.quantity, 0);
    const unitPrice = safeNumber(linkDraft.unitPrice, 0);
    const paidTotal = safeNumber(linkDraft.paidTotal, 0);
    if (!name) { setDraftError("상품명을 입력해 주세요."); return; }
    if (!Number.isInteger(quantity) || quantity < 1) { setDraftError("수량은 1개 이상이어야 합니다."); return; }
    if (unitPrice < 1) { setDraftError("실제 구매 예정 단가를 입력해 주세요."); return; }
    const error = applyOrder({
      mall: linkDraft.mall,
      sourceUrl: linkDraft.sourceUrl,
      orderNo: linkDraft.productId === "상품 링크" ? "상품 링크" : `상품번호 ${linkDraft.productId}`,
      paidTotal: paidTotal || quantity * unitPrice,
      _warnings: paidTotal ? [] : ["V08"],
      _extractedBy: "confirmed-link-draft",
      items: [{
        내용: name,
        규격: linkDraft.spec.trim(),
        단위: linkDraft.unit.trim() || "개",
        수량: quantity,
        단가: unitPrice,
        금액: quantity * unitPrice,
        _rawName: name,
        _warnings: [],
        excluded: false,
      }],
    }, "상품 링크 초안");
    if (error) { setDraftError(error); return; }
    setLinkKind("success");
    setLinkStatus("확인한 상품을 검수표에 추가했어요. 결제 총액만 마지막으로 대조해 주세요.");
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
      sourceUrl: meta.sourceUrl,
      reviewedAt: new Date().toISOString(),
      items: items.map((item) => ({
        내용: item.내용,
        규격: item.규격,
        단위: item.단위,
        수량: item.수량,
        단가: item.단가,
        금액: item.수량 * item.단가,
        _rawName: item._rawName,
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
          <div className="quick-start-copy"><span>STEP 1 · 가장 쉬운 방법</span><h2 id="quick-start-title">상품 링크만 붙여넣으세요</h2><p>상품번호와 공개 정보를 먼저 채우고, 링크에 없는 수량·옵션·실제 단가만 확인합니다.</p></div>
          <form className="link-import-form" onSubmit={(event) => { event.preventDefault(); void analyzeShoppingLink(); }}>
            <label htmlFor="shopping-url">쇼핑몰 상품 링크</label>
            <div><input id="shopping-url" type="url" value={shoppingUrl} onChange={(event) => { setShoppingUrl(event.target.value); setLinkDraft(null); setDraftError(""); setLinkKind("idle"); setLinkStatus("상품 링크를 붙여넣으면 견적 초안을 만들어요."); }} placeholder="https://… 상품 링크를 붙여넣으세요" autoComplete="url" /><button type="submit" disabled={!shoppingUrl.trim() || linkKind === "working"}>{linkKind === "working" ? "확인 중…" : "상품 초안 만들기"}</button></div>
          </form>
          <div className={`link-status ${linkKind}`} aria-live="polite"><span aria-hidden="true" />{linkStatus}</div>
          {linkDraft && (
            <section className="link-draft-card" aria-labelledby="link-draft-title">
              <div className="link-draft-heading">
                <div><span className="mall-badge">{linkDraft.mall} · {linkDraft.productId}</span><h3 id="link-draft-title">부족한 값만 확인해 주세요</h3><p>{linkDraft.lookupStatus === "found" ? "공개 상품정보를 먼저 채웠습니다. 실제 구매 조건과 같은지 확인하세요." : "쇼핑몰이 자동 조회를 막아도 상품 링크는 보존했습니다. 원본을 보며 빈칸만 입력하세요."}</p></div>
                <a href={linkDraft.sourceUrl} target="_blank" rel="noreferrer">원본 상품 확인 ↗</a>
              </div>
              <div className="link-draft-grid">
                <label className="draft-name">내용 <b>필수</b><input value={linkDraft.name} onChange={(event) => updateLinkDraft({ name: event.target.value })} placeholder="상품명을 입력하세요" /></label>
                <label>규격·옵션 <b>선택</b><input value={linkDraft.spec} onChange={(event) => updateLinkDraft({ spec: event.target.value })} placeholder="예: 250mL · 파란색" /></label>
                <label>단위 <b>필수</b><input value={linkDraft.unit} onChange={(event) => updateLinkDraft({ unit: event.target.value })} placeholder="개" /></label>
                <label>수량 <b>필수</b><input type="number" min="1" step="1" value={linkDraft.quantity} onChange={(event) => updateLinkDraft({ quantity: safeNumber(event.target.value, 1) })} /></label>
                <label>예상단가 <b>필수</b><span className="money-field"><input type="number" min="0" step="1" value={linkDraft.unitPrice || ""} onChange={(event) => updateLinkDraft({ unitPrice: safeNumber(event.target.value) })} placeholder="0" /><i>원</i></span></label>
                <label>결제 총액 <b>선택</b><span className="money-field"><input type="number" min="0" step="1" value={linkDraft.paidTotal} onChange={(event) => updateLinkDraft({ paidTotal: event.target.value })} placeholder="쿠폰·배송비 포함" /><i>원</i></span></label>
              </div>
              <div className="link-draft-footer">
                <div><span>예상금액</span><strong>{won(linkDraft.quantity * linkDraft.unitPrice)}원</strong><small>수량 × 예상단가</small></div>
                <button type="button" onClick={addLinkDraft}>확인하고 검수표에 추가</button>
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
            <p className="eyebrow">{meta.mall} · 주문 {meta.orderNo}</p>
            <h1>내역을 한 번 더<br />확인해 주세요.</h1>
            <p className="heading-copy">기계가 옮겨 적고, 선생님이 판단합니다.<br />노란 표시만 확인하면 견적서가 완성돼요.</p>
            {meta.sourceUrl && <a className="source-link" href={meta.sourceUrl} target="_blank" rel="noreferrer">원본 주문내역 열기 <span aria-hidden="true">↗</span></a>}
          </div>
          <div className="summary-card" aria-label="합계 요약">
            <div className="summary-topline"><span>결제 총액</span><label className="paid-total-input"><input type="number" min="0" step="1" value={meta.paidTotal} onChange={(event) => setMeta((current) => ({ ...current, paidTotal: safeNumber(event.target.value), warnings: current.warnings.filter((warning) => warning !== "V08") }))} aria-label="결제 총액" /><b>원</b></label></div>
            <div className="summary-metric"><span>포함 품목 합계</span><b>{won(totals.total)}원</b></div>
            {totals.delta === 0 ? <div className="match-pill"><span aria-hidden="true">✓</span> 결제 금액과 정확히 일치해요</div> : <div className="match-pill mismatch"><span aria-hidden="true">!</span> 차액 {totals.delta > 0 ? "+" : ""}{won(totals.delta)}원</div>}
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
            <p>위에 장바구니·주문 링크를 붙여넣거나 PDF, 엑셀 견적서, 장바구니 캡처를 올려 주세요.</p>
            <button type="button" onClick={() => setImportOpen(true)}>파일이나 주문 화면으로 시작하기</button>
          </section>
        )}

        <section className="help-stack" aria-label="가져오기 도움말">
          <details>
            <summary><span>정확하게 가져오는 권장 순서</span><b>+</b></summary>
            <div><p><strong>상품 1개</strong> 링크를 붙여넣고 자동으로 채워진 값과 수량·실제 단가를 확인합니다.</p><p><strong>여러 상품</strong> 쇼핑몰에서 내려받은 엑셀·PDF를 올립니다. 파일이 없으면 글자를 크게 확대한 장바구니 캡처를 사용하세요.</p><p><strong>마지막 수단</strong> 로그인 주문 화면 한꺼번에 가져오기는 고급 기능에서 이용할 수 있습니다.</p></div>
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
