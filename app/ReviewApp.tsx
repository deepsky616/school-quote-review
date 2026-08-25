"use client";

import { useCallback, useMemo, useState } from "react";
import ImportDialog from "./ImportDialog.tsx";
import { parseOrderText } from "./orderTextParser.mjs";

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

const shoppingOrderLinks = [
  { name: "아이스크림몰", href: "https://i-screammall.co.kr/", hint: "로그인 후 주문내역" },
  { name: "쿠팡", href: "https://mc.coupang.com/ssr/desktop/order/list", hint: "주문목록" },
  { name: "G마켓", href: "https://myg.gmarket.co.kr/", hint: "나의 쇼핑정보" },
  { name: "YES24", href: "https://www.yes24.com/Member/FTMypageMain.aspx", hint: "마이페이지" },
];

const warningText: Record<string, string> = {
  V02: "품명 비어 있음",
  V03: "품명 미확정",
  V04: "수량 확인 필요",
  V05: "단가 확인 필요",
  V06: "수량과 금액 불일치",
  V07: "결제 총액 불일치",
  V08: "결제 총액 확인 필요",
  V09: "캡처 OCR 결과 확인 필요",
  V11: "가격 기준 확인 필요",
  V12: "외화 항목 확인 필요",
  V13: "취소·반품 의심",
  V15: "예산 한도 초과",
};

const blockingRules = new Set(["V01", "V04", "V05", "V07", "V11", "V12", "V15"]);
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

function makeXlsx(items: ReviewItem[]) {
  const included = items.filter((item) => !item.excluded);
  const textCell = (ref: string, value: string, style: number) => `<c r="${ref}" t="inlineStr" s="${style}"><is><t>${escapeXml(value)}</t></is></c>`;
  const numberCell = (ref: string, value: number, style: number) => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  const rows = included.map((item, index) => {
    const rowNo = index + 2;
    return `<row r="${rowNo}" ht="17" customHeight="1">${textCell(`A${rowNo}`, item.내용, 2)}${textCell(`B${rowNo}`, item.규격, 2)}${textCell(`C${rowNo}`, item.단위, 2)}${numberCell(`D${rowNo}`, item.수량, 2)}${numberCell(`E${rowNo}`, item.단가, 3)}</row>`;
  }).join("");
  const lastRow = Math.max(1, included.length + 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:E${lastRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="17"/>
<cols><col min="1" max="5" width="14.0625" customWidth="1"/></cols><sheetData>
<row r="1" ht="17" customHeight="1">${textCell("A1", "내용", 1)}${textCell("B1", "규격", 1)}${textCell("C1", "단위", 1)}${textCell("D1", "수량", 1)}${textCell("E1", "예상단가", 1)}</row>
${rows}
</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0_ "/></numFmts><fonts count="3"><font><sz val="9"/><name val="돋움"/></font><font><b/><sz val="9"/><color rgb="FFFFFFFF"/><name val="돋움"/></font><font><sz val="9"/><color rgb="FF008000"/><name val="돋움"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9DED9"/></left><right style="thin"><color rgb="FFD9DED9"/></right><top style="thin"><color rgb="FFD9DED9"/></top><bottom style="thin"><color rgb="FFD9DED9"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs></styleSheet>`;

  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="품목내역" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
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
  const [pasteText, setPasteText] = useState("");
  const [pasteTotal, setPasteTotal] = useState("");
  const [pasteStatus, setPasteStatus] = useState("주문 화면 전체를 복사하면 상품명·수량·최종 할인가·배송비를 구분합니다.");
  const [pasteKind, setPasteKind] = useState<"idle" | "success" | "error">("idle");
  const totals = useMemo(() => {
    const included = items.filter((item) => !item.excluded);
    const total = included.reduce((sum, item) => sum + item.수량 * item.단가, 0);
    const warnings = [...meta.warnings, ...items.flatMap((item) => item.warnings)];
    if (meta.stage === "post-purchase" && meta.paidTotal && meta.paidTotal !== total) warnings.push("V07");
    if (meta.stage === "pre-purchase" && meta.budget > 0 && total > meta.budget) warnings.push("V15");
    const comparison = meta.stage === "pre-purchase" ? meta.budget : meta.paidTotal;
    return { total, delta: comparison - total, warnings, included };
  }, [items, meta.budget, meta.paidTotal, meta.stage, meta.warnings]);

  const visibleItems = issuesOnly ? items.filter((item) => item.warnings.length > 0) : items;
  const hasBlock = totals.warnings.some((warning) => blockingRules.has(warning));
  const hasItems = items.length > 0;
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

  const importPastedOrder = () => {
    try {
      const order = parseOrderText(pasteText, { paidTotal: pasteTotal });
      const error = applyOrder(order, "붙여넣은 주문 화면");
      if (error) throw new Error(error);
      setPasteKind("success");
      setPasteStatus("품목을 정리했습니다. 아래 검수표에서 노란 표시만 확인해 주세요.");
    } catch (error) {
      setPasteKind("error");
      setPasteStatus(error instanceof Error ? error.message : "붙여넣은 내용을 읽지 못했습니다.");
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error("클립보드가 비어 있습니다.");
      setPasteText(text);
      setPasteKind("success");
      setPasteStatus("클립보드 내용을 붙여넣었습니다. ‘품목 자동 작성’을 눌러 주세요.");
    } catch {
      setPasteKind("error");
      setPasteStatus("입력칸을 누르고 Ctrl+V로 붙여넣어 주세요.");
    }
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
    const safeOrderNo = meta.orderNo.replace(/[\\/:*?"<>|]/g, "_");
    download(makeXlsx(items), `품목내역(통합)_${safeOrderNo}.xlsx`);
    setMessage("품목내역(통합) 양식으로 만들었어요");
  };

  return (
    <main className="app-shell">
      {isImportOpen && <ImportDialog onClose={() => setImportOpen(false)} onImport={applyOrder} />}
      <header className="topbar">
        <a className="brand" href="#top" aria-label="견적정리 홈"><span className="brand-mark" aria-hidden="true">견</span><span>견적정리</span></a>
        <div className="stepper" aria-label="진행 단계"><span className={`step ${hasItems ? "done" : "active"}`}><b>1</b> 주문 화면 붙여넣기</span><span className={`step ${hasItems ? "active" : ""}`}><b>2</b> 내용 확인·수정</span><span className="step"><b>3</b> 엑셀 다운로드</span><span className="step"><b>4</b> K-에듀파인 등록</span></div>
        <button className="ghost-button" type="button" onClick={() => setImportOpen(true)}>주문내역 가져오기</button>
      </header>

      <section className="workspace" id="top">
        <section className="quick-start" aria-labelledby="quick-start-title">
          <div className="quick-start-copy"><span>STEP 1 · 가장 쉬운 방법</span><h2 id="quick-start-title">주문 화면을 복사해 그대로 붙여넣으세요</h2><p>아이스크림몰·쿠팡·G마켓·YES24 주문 형식을 자동 구분하고, 여러 가격 중 최종 할인가를 사용합니다.</p></div>
          <nav className="shopping-order-links" aria-label="지원 쇼핑몰 주문 화면 바로가기">
            <div className="shopping-order-guide"><strong>주문 화면 열기</strong><span>쇼핑몰에 로그인한 뒤 주문내역에서 Ctrl+A → Ctrl+C 하세요.</span></div>
            <div className="shopping-order-list">
              {shoppingOrderLinks.map((shop) => <a key={shop.name} href={shop.href} target="_blank" rel="noreferrer"><b>{shop.name}</b><span>{shop.hint}</span><em aria-hidden="true">↗</em></a>)}
            </div>
            <p>바로가기는 주문 화면을 여는 용도이며 자동 수집하지 않습니다. 복사한 내용을 아래에 붙여넣어 주세요.</p>
          </nav>
          <form className="link-import-form paste-import-form" onSubmit={(event) => { event.preventDefault(); importPastedOrder(); }}>
            <label htmlFor="order-screen-text">장바구니 또는 주문내역 전체</label>
            <div><textarea id="order-screen-text" value={pasteText} onChange={(event) => { setPasteText(event.target.value); setPasteKind("idle"); setPasteStatus("주문 화면 전체를 복사하면 상품명·수량·최종 할인가·배송비를 구분합니다."); }} placeholder={"쇼핑몰 주문 화면에서 Ctrl+A → Ctrl+C 후 여기에 Ctrl+V\n\n상품명 · 옵션 · 수량 · 정가 · 할인가 · 배송비가 함께 있어도 됩니다."} rows={8} /><button type="submit" disabled={!pasteText.trim()}>품목 자동 작성</button></div>
          </form>
          <div className={`link-status ${pasteKind}`} aria-live="polite"><span aria-hidden="true" />{pasteStatus}</div>
          <div className="paste-primary-actions"><button type="button" onClick={() => void pasteFromClipboard()}>클립보드에서 붙여넣기</button><label>결제 총액 <span>선택</span><input type="number" min="0" step="1" value={pasteTotal} onChange={(event) => setPasteTotal(event.target.value)} placeholder="예: 77800" /></label></div>
          <div className="quick-start-fallback"><span>다른 자료가 있다면</span><button type="button" onClick={() => setImportOpen(true)}>PDF·엑셀·캡처·직접 입력</button></div>
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
            <p>위 입력칸에 주문 화면 전체를 붙여넣거나 PDF, 엑셀 견적서, 장바구니 캡처를 올려 주세요.</p>
            <button type="button" onClick={() => setImportOpen(true)}>파일이나 주문 화면으로 시작하기</button>
          </section>
        )}

        <section className="help-stack" aria-label="가져오기 도움말">
          <details>
            <summary><span>정확하게 가져오는 권장 순서</span><b>+</b></summary>
            <div><p><strong>기본 방법</strong> 쇼핑몰 주문 화면에서 전체 선택 후 복사하고, 첫 입력칸에 그대로 붙여넣습니다.</p><p><strong>파일 자료</strong> 쇼핑몰에서 내려받은 엑셀·PDF가 있으면 보조 방법으로 올릴 수 있습니다.</p><p><strong>최종 확인</strong> 노란 표시가 있는 수량·예상단가만 원본 주문과 대조합니다.</p></div>
          </details>
          <details>
            <summary><span>붙여넣은 뒤 무엇을 확인하나요?</span><b>+</b></summary>
            <div><p>정가·쿠폰·할인율·적립금·판매자·배송상태는 상품명에서 제외합니다. 수량이나 최종 할인가를 확정할 수 없는 값만 <strong>V04·V11</strong>로 표시합니다.</p></div>
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
