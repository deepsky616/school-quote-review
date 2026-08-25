"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { importPdf } from "./fileImport.mjs";
import { parseOrderText } from "./orderTextParser.mjs";

type ImportMode = "paste" | "file" | "paper" | "browser" | "manual";

type ImportDialogProps = {
  onClose: () => void;
  onImport: (order: unknown, label: string) => string | null;
};

type BridgeMessage = {
  type?: string;
  source?: string;
  payload?: unknown;
  error?: string;
};

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(current.trim()); current = "";
    } else current += character;
  }
  cells.push(current.trim());
  return cells;
}

function csvToOrder(text: string, filename: string) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).map(parseCsvLine);
  if (rows.length < 2) throw new Error("[V01] CSV에 품목 행이 없습니다.");
  const headers = rows[0].map((header) => header.trim().replace(/\s+/g, "").toLowerCase());
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const nameIndex = column("내용", "품명", "상품명", "name");
  const specIndex = column("규격", "옵션", "spec");
  const unitIndex = column("단위", "unit");
  const qtyIndex = column("수량", "qty", "quantity");
  const priceIndex = column("예상단가", "단가", "price");
  const amountIndex = column("예상금액", "금액", "결제금액", "amount");
  if (nameIndex < 0 || qtyIndex < 0 || (priceIndex < 0 && amountIndex < 0)) {
    throw new Error("[V01] CSV에 품명·수량·예상단가(또는 예상금액) 열이 필요합니다.");
  }
  const number = (value = "") => Number(value.replace(/[^\d.-]/g, ""));
  const items = rows.slice(1).flatMap((row) => {
    if (!row[nameIndex]?.trim()) return [];
    const qty = number(row[qtyIndex]) || 1;
    const amount = amountIndex >= 0 ? number(row[amountIndex]) : 0;
    const price = priceIndex >= 0 ? number(row[priceIndex]) : Math.round(amount / qty);
    return [{
      내용: row[nameIndex] ?? "", 규격: specIndex >= 0 ? row[specIndex] ?? "" : "",
      단위: unitIndex >= 0 ? row[unitIndex] || "개" : "개", 수량: qty, 단가: price,
      금액: amount || qty * price, _rawName: row[nameIndex] ?? "", excluded: false,
    }];
  });
  return {
    mall: filename.replace(/\.csv$/i, ""), capturedAt: new Date().toISOString(),
    paidTotal: items.reduce((sum, item) => sum + item.금액, 0), _warnings: ["V08"], _extractedBy: "csv", items,
  };
}

export default function ImportDialog({ onClose, onImport }: ImportDialogProps) {
  const [mode, setMode] = useState<ImportMode>("paste");
  const [status, setStatus] = useState("주문 화면을 복사해 붙여넣는 방법이 기본입니다.");
  const [statusKind, setStatusKind] = useState<"idle" | "working" | "success" | "error">("idle");
  const [pasteText, setPasteText] = useState("");
  const [pasteTotal, setPasteTotal] = useState("");
  const [mall, setMall] = useState("");
  const [orderNo, setOrderNo] = useState("");
  const [paidTotal, setPaidTotal] = useState("");
  const [manualRows, setManualRows] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const requestTimer = useRef<number | null>(null);

  useEffect(() => {
    const receiveCapture = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.type !== "QUOTE_REVIEW_CAPTURE_RESULT" || data.source !== "quote-review-extension") return;
      if (requestTimer.current) window.clearTimeout(requestTimer.current);
      if (data.error || !data.payload) {
        setStatusKind("error");
        setStatus(data.error ?? "저장된 주문내역이 없습니다. 쇼핑몰 화면에서 도우미를 먼저 실행해 주세요.");
        return;
      }
      const importError = onImport(data.payload, "브라우저 주문내역");
      if (importError) { setStatusKind("error"); setStatus(importError); }
    };
    window.addEventListener("message", receiveCapture);
    return () => {
      window.removeEventListener("message", receiveCapture);
      if (requestTimer.current) window.clearTimeout(requestTimer.current);
    };
  }, [onImport]);

  const requestBrowserCapture = () => {
    setStatusKind("working");
    setStatus("브라우저 도우미를 확인하고 있어요…");
    window.postMessage({ type: "QUOTE_REVIEW_REQUEST_CAPTURE", version: 1 }, window.location.origin);
    requestTimer.current = window.setTimeout(() => {
      setStatusKind("error");
      setStatus("도우미가 응답하지 않았어요. 설치 후 쇼핑몰 주문 화면에서 먼저 실행해 주세요.");
    }, 1600);
  };

  const importPastedOrder = () => {
    try {
      const order = parseOrderText(pasteText, { paidTotal: pasteTotal });
      const importError = onImport(order, "붙여넣은 주문 화면");
      if (importError) throw new Error(importError);
    } catch (error) {
      setStatusKind("error");
      setStatus(error instanceof Error ? error.message : "붙여넣은 내용을 읽지 못했습니다.");
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error("클립보드가 비어 있습니다.");
      setPasteText(text);
      setStatusKind("success");
      setStatus("클립보드 내용을 붙여넣었어요. 아래에서 검수를 시작하세요.");
    } catch {
      setStatusKind("error");
      setStatus("클립보드 접근이 차단됐어요. 입력 상자를 누르고 Ctrl+V로 붙여넣어 주세요.");
    }
  };

  const importFileObject = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      setStatusKind("error"); setStatus("파일은 25MB 이하로 올려 주세요."); return;
    }
    setStatusKind("working");
    setStatus("파일을 브라우저 안에서 읽고 있어요…");
    try {
      const lower = file.name.toLowerCase();
      if (!lower.endsWith(".pdf") && file.type !== "application/pdf") throw new Error("PDF 파일만 올릴 수 있습니다.");
      const order = await importPdf(file, (progress: number, label: string) => {
        setStatusKind("working"); setStatus(`${label} ${Math.round(progress * 100)}%`);
      });
      const importError = onImport(order, file.name);
      if (importError) throw new Error(importError);
    } catch (error) {
      setStatusKind("error");
      setStatus(error instanceof Error ? error.message : "파일을 읽지 못했습니다.");
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await importFileObject(file);
    event.target.value = "";
  };

  const dropFile = async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) await importFileObject(file);
  };

  const importManual = () => {
    try {
      const rows = manualRows.split(/\r?\n/).filter((row) => row.trim()).map((row, index) => {
        const cells = row.split(/\t|\s*\|\s*/);
        const hasUnit = cells.length >= 5;
        const qtyCell = hasUnit ? cells[3] : cells[2];
        const priceCell = hasUnit ? cells[4] : cells[3];
        const qty = Number((qtyCell ?? "1").replace(/[^\d.-]/g, ""));
        const price = Number((priceCell ?? "0").replace(/[^\d.-]/g, ""));
        if (!cells[0]?.trim()) throw new Error(`[V02] ${index + 1}행의 품명이 비어 있습니다.`);
        const safeQty = Number.isInteger(qty) && qty > 0 ? qty : 1;
        const safePrice = Number.isFinite(price) ? Math.round(price) : 0;
        return {
          내용: cells[0].trim(), 규격: cells[1]?.trim() ?? "", 단위: hasUnit ? cells[2]?.trim() || "개" : "개",
          수량: safeQty, 단가: safePrice, 금액: safeQty * safePrice,
          _rawName: cells[0].trim(), excluded: false,
        };
      });
      if (!rows.length) throw new Error("[V01] 품목을 한 줄 이상 입력해 주세요.");
      const importError = onImport({
        mall: mall || "직접 입력", orderNo: orderNo || undefined,
        capturedAt: new Date().toISOString(),
        paidTotal: Number(paidTotal.replace(/[^\d.-]/g, "")) || rows.reduce((sum, row) => sum + row.금액, 0),
        _warnings: paidTotal ? [] : ["V08"], _extractedBy: "manual", items: rows,
      }, "직접 입력");
      if (importError) throw new Error(importError);
    } catch (error) {
      setStatusKind("error");
      setStatus(error instanceof Error ? error.message : "입력 내용을 확인해 주세요.");
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="dialog-heading">
          <div><p className="dialog-kicker">ORDER IMPORT</p><h2 id="import-title">주문내역 불러오기</h2><p>설치 없이 복사·붙여넣기하거나, 주문 화면·종이 문서를 PDF로 올려 주세요.</p></div>
          <button className="dialog-close" type="button" onClick={onClose} aria-label="닫기">×</button>
        </div>

        <div className="import-tabs five-tabs" role="tablist" aria-label="불러오기 방법">
          <button className={mode === "paste" ? "active" : ""} type="button" role="tab" aria-selected={mode === "paste"} onClick={() => setMode("paste")}><span className="recommended-dot" />텍스트 붙여넣기</button>
          <button className={mode === "file" ? "active" : ""} type="button" role="tab" aria-selected={mode === "file"} onClick={() => setMode("file")}>PDF 문서</button>
          <button className={mode === "paper" ? "active" : ""} type="button" role="tab" aria-selected={mode === "paper"} onClick={() => setMode("paper")}>종이 견적서·영수증</button>
          <button className={mode === "browser" ? "active" : ""} type="button" role="tab" aria-selected={mode === "browser"} onClick={() => setMode("browser")}>도우미</button>
          <button className={mode === "manual" ? "active" : ""} type="button" role="tab" aria-selected={mode === "manual"} onClick={() => setMode("manual")}>직접 입력</button>
        </div>

        {mode === "paste" && (
          <div className="import-panel" role="tabpanel">
            <div className="recommended-card paste-card">
              <div className="recommended-label secondary-label">아이스크림몰 · 쿠팡 · G마켓 · YES24 · 11번가 자동 구분</div>
              <h3>주문 화면을 그대로 복사해 붙여넣으세요</h3>
              <p>상품명·옵션·수량·최종 할인가를 묶어 읽습니다. 정가·할인율·쿠폰·적립금·판매자·배송상태는 상품명에서 제외하고, 금액이 있는 배송비는 별도 품목으로 만듭니다.</p>
              <textarea className="paste-area" value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder={"여기를 누르고 Ctrl+V\n\n상품명 · 옵션 · 수량 · 정가 · 최종 할인가 · 배송비가 포함된 주문 화면"} rows={7} />
              <div className="paste-meta-grid">
                <label>결제 총액 <span>못 찾을 때만</span><input inputMode="numeric" value={pasteTotal} onChange={(event) => setPasteTotal(event.target.value)} placeholder="예: 77800" /></label>
              </div>
              <div className="paste-actions">
                <button className="clipboard-button" type="button" onClick={pasteFromClipboard}>클립보드에서 붙여넣기</button>
                <button className="dialog-primary" type="button" onClick={importPastedOrder} disabled={!pasteText.trim()}>붙여넣은 내용 검수하기 <span aria-hidden="true">→</span></button>
              </div>
            </div>
          </div>
        )}

        {mode === "file" && (
          <div className="import-panel" role="tabpanel">
            <input ref={fileRef} className="file-input" type="file" accept=".pdf,application/pdf" onChange={importFile} />
            <button className="drop-zone" type="button" onClick={() => fileRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={dropFile}>
              <span className="drop-icon" aria-hidden="true">↑</span>
              <strong>주문내역 PDF 선택</strong>
              <small>브라우저 인쇄에서 저장한 PDF 또는 문자 인식이 포함된 스캔 PDF</small>
            </button>
            <p className="format-fallback">사진·이미지 파일은 받지 않습니다. 종이 견적서는 문자 인식(OCR)이 포함된 PDF로 스캔해 주세요.</p>
          </div>
        )}

        {mode === "paper" && (
          <div className="import-panel" role="tabpanel">
            <div className="pdf-save-guide modal-paper-guide">
              <div className="pdf-save-heading"><div><span>가장 정확한 스캔 방법</span><h3>휴대폰 또는 프린터·복합기로 PDF를 만드세요</h3></div><em>사진 파일 업로드 안 함</em></div>
              <div className="paper-scan-methods">
                <section className="paper-scan-method" aria-label="휴대폰 스캔 방법">
                  <div className="paper-method-heading"><span aria-hidden="true">A</span><div><h4>휴대폰 문서 스캔</h4><p>자동 테두리 보정과 OCR 사용</p></div></div>
                  <ol className="paper-method-steps">
                    <li><b>1</b><div><strong>평평하고 밝게 놓기</strong><p>표 전체와 네 모서리가 보이게 하세요.</p></div></li>
                    <li><b>2</b><div><strong>‘문서 스캔’ 선택</strong><p>자동 보정과 <mark>문자 인식(OCR)</mark>을 켜세요.</p></div></li>
                    <li><b>3</b><div><strong>한 PDF로 저장</strong><p>여러 장을 합치고 300dpi 또는 원본 크기로 저장하세요.</p></div></li>
                  </ol>
                </section>
                <section className="paper-scan-method" aria-label="프린터 복합기 스캔 방법">
                  <div className="paper-method-heading"><span aria-hidden="true">B</span><div><h4>프린터·복합기 스캔</h4><p>원고대 또는 자동급지대 사용</p></div></div>
                  <ol className="paper-method-steps">
                    <li><b>1</b><div><strong>종이 넣기</strong><p>영수증은 원고대에, 여러 장은 자동급지대(ADF)에 넣으세요.</p></div></li>
                    <li><b>2</b><div><strong>PDF·300dpi 선택</strong><p>프린터나 PC 스캔 메뉴에서 PDF와 300dpi를 선택하세요.</p></div></li>
                    <li><b>3</b><div><strong>OCR 후 한 파일 저장</strong><p>검색 가능한 PDF·텍스트 인식을 켜고 여러 페이지를 한 파일로 저장하세요.</p></div></li>
                  </ol>
                </section>
              </div>
              <div className="paper-checklist"><strong>저장 후 확인</strong><span>상품명·단가·수량·합계가 선명함</span><span>PDF에서 글자 선택·검색 가능</span><span>페이지 잘림 없음</span></div>
              <p className="pdf-save-tip"><span aria-hidden="true">i</span> 복합기에 OCR 항목이 없으면 제조사 PC 스캔 프로그램에서 ‘검색 가능한 PDF’ 또는 ‘텍스트 인식’을 선택하세요.</p>
            </div>
            <button className="dialog-primary paper-dialog-action" type="button" onClick={() => setMode("file")}>만든 PDF 선택하기 <span aria-hidden="true">→</span></button>
          </div>
        )}

        {mode === "browser" && (
          <div className="import-panel" role="tabpanel">
            <div className="optional-card">
              <div className="optional-label">선택 기능</div>
              <h3>주문을 자주 가져올 때만 사용하세요</h3>
              <p>브라우저 도우미는 반복 작업에는 빠르지만 최초 설치가 필요합니다. 대부분은 붙여넣기가 더 간단합니다.</p>
              <ol className="capture-steps" aria-label="브라우저 도우미 최초 설치 순서">
                <li><b>1</b><span>도우미 ZIP을 내려받아 <strong>압축을 풉니다.</strong></span></li>
                <li><b>2</b><span>Chrome은 <strong>chrome://extensions</strong>, Edge는 <strong>edge://extensions</strong>에서 개발자 모드를 켭니다.</span></li>
                <li><b>3</b><span><strong>압축해제된 확장 프로그램 로드</strong>를 눌러 압축을 푼 폴더를 선택합니다.</span></li>
              </ol>
              <div className="browser-actions">
                <a className="helper-download" href="./gyeonjeok-helper.zip" download>브라우저 도우미 받기</a>
                <button className="dialog-primary" type="button" onClick={requestBrowserCapture}>저장된 주문내역 가져오기 <span aria-hidden="true">→</span></button>
              </div>
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div className="import-panel manual-panel" role="tabpanel">
            <div className="manual-grid">
              <label>쇼핑몰 이름<input value={mall} onChange={(event) => setMall(event.target.value)} placeholder="예: 쿠팡" /></label>
              <label>주문번호<input value={orderNo} onChange={(event) => setOrderNo(event.target.value)} placeholder="선택 입력" /></label>
              <label>결제 총액<input inputMode="numeric" value={paidTotal} onChange={(event) => setPaidTotal(event.target.value)} placeholder="예: 77800" /></label>
              <label className="wide-field">품목 붙여넣기<textarea value={manualRows} onChange={(event) => setManualRows(event.target.value)} placeholder={"내용 | 규격 | 단위 | 수량 | 예상단가\n비커 250mL | 붕규산 유리 | 개 | 20 | 2400"} rows={5} /></label>
            </div>
            <button className="dialog-primary manual-submit" type="button" onClick={importManual}>검수 화면으로 가져오기 <span aria-hidden="true">→</span></button>
          </div>
        )}

        <div className={`import-status ${statusKind}`} aria-live="polite"><span aria-hidden="true" />{status}</div>
        <p className="privacy-note">개인정보 보호 · 주문 문서는 서버에 저장하지 않고 이 브라우저 안에서만 처리됩니다.</p>
      </section>
    </div>
  );
}
