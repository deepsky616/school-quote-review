import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  elevenStreetPositionedPagesToOrder,
  gmarketPositionedPagesToOrder,
  importPdf,
  iscreamPositionedPagesToOrder,
  kyoboPositionedPagesToOrder,
  mananPositionedPagesToOrder,
  paperQuotePositionedPagesToOrder,
  spreadsheetRowsToOrder,
  teachermallPositionedPagesToOrder,
  yes24PositionedPagesToOrder,
} from "../app/fileImport.mjs";
import { parseOrderText } from "../app/orderTextParser.mjs";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("https://quote-review.test/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("견적 검수 화면을 서버에서 렌더링한다", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /에듀파인 품의내역 생성기/);
  assert.match(html, /brand-mark[^>]*>📋<\/span>/);
  assert.match(html, /주문내역을 가져오는 방법을 선택하세요/);
  assert.match(html, /주문 화면 복사·붙이기/);
  assert.match(html, /PDF 문서/);
  assert.match(html, /종이 견적서·영수증/);
  assert.match(html, /품목 자동 작성/);
  assert.match(html, /아직 불러온 품목이 없어요/);
  assert.match(html, /정확하게 가져오는 권장 순서/);
  assert.match(html, /K-에듀파인 등록/);
  assert.doesNotMatch(html, /상품 링크를 한 줄에 하나씩|상품 초안 만들기|링크에서 가져오기/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("검수·저장·xlsx 안전 규칙을 제품 코드에 유지한다", async () => {
  const [source, layout, packageJson, pagesEntry] = await Promise.all([
    readFile(new URL("../app/ReviewApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../pages-app/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(source, /sheet name="품목내역"/);
  assert.match(source, /textCell\("A1", "내용", 1\)/);
  assert.match(source, /textCell\("B1", "규격", 1\)/);
  assert.match(source, /textCell\("C1", "단위", 1\)/);
  assert.match(source, /textCell\("D1", "수량", 1\)/);
  assert.match(source, /textCell\("E1", "예상단가", 1\)/);
  assert.match(source, /width="14\.0625"/);
  assert.match(source, /품목내역\(통합\)_\$\{safeOrderNo\}\.xlsx/);
  assert.doesNotMatch(source, /SUM\(G8:G25\)|IF\(E\$\{rowNo\}|Math\.ceil\(included\.length \/ 18\)/);
  assert.doesNotMatch(source, /order\.reviewed\.json|검수 내용 저장/);
  assert.match(source, /const addItem = \(\) =>/);
  assert.match(source, /manuallyAdded: true/);
  assert.match(source, /품목 추가/);
  assert.match(source, /const removeItem = \(id: string\) =>/);
  assert.match(source, /행 삭제/);
  assert.match(source, /품목내역 엑셀 파일 생성/);
  assert.doesNotMatch(source, />견적서 생성 </);
  assert.doesNotMatch(source, /className="ghost-button" type="button" onClick=\{\(\) => setImportOpen\(true\)\}>주문내역 가져오기<\/button>/);
  assert.match(source, /V15: "예산 한도 초과"/);
  assert.match(source, /blockingRules = new Set\(\["V01", "V02", "V04", "V05", "V07", "V11", "V12", "V15"\]\)/);
  assert.match(source, /stage === "pre-purchase"/);
  assert.match(source, /new Blob\(\[bytes\.buffer as ArrayBuffer\]/);
  assert.match(layout, /new URL\("\/og-edufine\.png", base\)/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(packageJson, /tesseract\.js/);
  assert.match(pagesEntry, /Content-Security-Policy/);
  assert.match(pagesEntry, /connect-src 'self'/);
  assert.match(pagesEntry, /object-src 'none'/);
  await access(new URL("../public/og-edufine.png", import.meta.url));
  await assert.rejects(access(new URL("../app/linkImport.mjs", import.meta.url)));
  await assert.rejects(access(new URL("../app/screenCapture.mjs", import.meta.url)));
  await assert.rejects(access(new URL("../app/chatgpt-auth.ts", import.meta.url)));
  await assert.rejects(access(new URL("../app/api/product-draft/route.ts", import.meta.url)));
});

test("스텝 1을 주문 화면 붙여넣기·PDF 문서·종이 문서 탭으로 구분하고 도우미를 보조 경로로 둔다", async () => {
  const [dialog, review, manifestText, extractor, bridge, popup] = await Promise.all([
    readFile(new URL("../app/ImportDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ReviewApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../extension/extractor.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/bridge.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.match(review, /id="order-screen-text"/);
  assert.match(review, /quickStartMode/);
  assert.match(review, /주문 화면 복사·붙이기/);
  assert.match(review, /role="tablist" aria-label="주문내역 가져오기 방법"/);
  assert.match(review, /먼저, 주문 화면 열기/);
  assert.ok(review.indexOf("shared-shopping-links") < review.indexOf("quick-start-tabs"));
  assert.match(review, /PDF 문서/);
  assert.match(review, /id="paper-method-tab"/);
  assert.match(review, /종이 견적서·영수증/);
  assert.match(review, /문자 인식\(OCR\) PDF/);
  assert.match(review, /프린터·복합기로 스캔/);
  assert.match(review, /자동급지대\(ADF\)/);
  assert.match(review, /해상도 <mark>300dpi<\/mark>/);
  assert.match(review, /검색 가능한 PDF/);
  assert.match(review, /스캔한 견적서·영수증 PDF를 선택하세요/);
  assert.match(review, /문자 인식 권장/);
  assert.equal((review.match(/onDrop=\{dropQuickFile\}/g) ?? []).length, 2);
  assert.doesNotMatch(review, /도우미 또는 직접 입력이 필요하신가요\?|다른 방법 보기/);
  assert.match(review, /만안문구처럼 주문 화면을 복사할 수 없을 때/);
  assert.match(review, /주문 화면을 PDF로 저장하는 방법/);
  assert.match(review, /Microsoft Print to PDF/);
  assert.match(review, /전체 페이지 저장 후 업로드/);
  assert.match(review, /importQuickFile/);
  assert.match(review, /importPdf\(file/);
  assert.doesNotMatch(review, /importExcel\(file|importImage\(file/);
  assert.match(review, /accept="\.pdf,application\/pdf"/);
  assert.match(review, /parseOrderText\(pasteText/);
  assert.match(review, /품목 자동 작성/);
  assert.match(review, /const clearPastedOrder = \(\) =>/);
  assert.match(review, /setPasteText\(""\)/);
  assert.match(review, /setPasteTotal\(""\)/);
  assert.match(review, /붙여넣은 주문내역 전체 지우기/);
  assert.match(review, /> 전체 지우기<\/button>/);
  assert.doesNotMatch(review, /클립보드에서 붙여넣기|navigator\.clipboard\.readText/);
  assert.doesNotMatch(dialog, /클립보드에서 붙여넣기|navigator\.clipboard\.readText/);
  assert.match(review, /지원 쇼핑몰 주문 화면 바로가기/);
  assert.match(review, /https:\/\/i-screammall\.co\.kr\//);
  assert.match(review, /https:\/\/mc\.coupang\.com\/ssr\/desktop\/order\/list/);
  assert.match(review, /https:\/\/myg\.gmarket\.co\.kr\//);
  assert.match(review, /https:\/\/www\.yes24\.com\/Member\/FTMypageMain\.aspx/);
  assert.match(review, /https:\/\/www\.11st\.co\.kr\//);
  assert.match(review, /https:\/\/www\.mananmungu\.co\.kr\/mall\/index\.php/);
  assert.match(review, /https:\/\/shop\.teacherville\.co\.kr\//);
  assert.match(review, /https:\/\/www\.kyobobook\.co\.kr\//);
  const shoppingLinkOrder = ["G마켓", "11번가", "쿠팡", "YES24", "교보문고", "아이스크림몰", "티처몰", "만안문구센터"];
  const shoppingLinksSource = review.slice(review.indexOf("const shoppingOrderLinks"), review.indexOf("const warningText"));
  const shoppingLinkPositions = shoppingLinkOrder.map((name) => shoppingLinksSource.indexOf(`name: "${name}"`));
  assert.ok(shoppingLinkPositions.every((position) => position >= 0));
  assert.deepEqual(shoppingLinkPositions, [...shoppingLinkPositions].sort((left, right) => left - right));
  assert.match(review, /장바구니·주문결제/);
  assert.match(review, /장바구니·주문내역 PDF/);
  assert.match(review, /자동 품목 구분은 위에 표시된 쇼핑몰 주문 화면을 기준으로 최적화/);
  assert.match(review, /다른 쇼핑몰은 값이 빠지거나 잘못 연결될 수 있으므로/);
  assert.match(review, /복사 붙여넣기와 PDF 방법 비교/);
  assert.match(review, /YES24·교보문고·G마켓·아이스크림몰·11번가·만안문구센터·티처몰 예시 구조/);
  assert.match(review, /자동 수집하지 않습니다/);
  assert.match(review, /<footer className="site-footer">/);
  assert.match(review, /개발자/);
  assert.match(review, /청계초등학교 조영석/);
  assert.doesNotMatch(review, /상품 링크를 한 줄에 하나씩|상품 초안 만들기|현재 화면 보내기|getDisplayMedia/);
  assert.match(dialog, /useState<ImportMode>\("paste"\)/);
  assert.match(dialog, /아이스크림몰 · 쿠팡 · G마켓 · YES24 · 교보문고 · 11번가 · 티처몰 자동 구분/);
  assert.match(dialog, /정가·할인율·쿠폰·적립금·판매자·배송상태/);
  assert.match(dialog, /주문내역 PDF 선택/);
  assert.match(dialog, /종이 견적서·영수증/);
  assert.match(dialog, /프린터·복합기 스캔/);
  assert.match(dialog, /PDF·300dpi 선택/);
  assert.match(dialog, /자동급지대\(ADF\)/);
  assert.match(dialog, /스캔한 견적서·영수증 PDF 선택/);
  assert.match(dialog, /선택한 PDF는 바로 품목으로 정리/);
  assert.equal((dialog.match(/onDrop=\{dropFile\}/g) ?? []).length, 2);
  assert.match(dialog, /chrome:\/\/extensions/);
  assert.match(dialog, /edge:\/\/extensions/);
  assert.match(dialog, /압축해제된 확장 프로그램 로드/);
  assert.match(dialog, /accept="\.pdf,application\/pdf"/);
  assert.doesNotMatch(dialog, /importExcel\(file|importImage\(file|accept="[^"]*\.png/);
  assert.doesNotMatch(dialog, /원본 주문 링크|원본 주소/);
  assert.match(dialog, /QUOTE_REVIEW_REQUEST_CAPTURE/);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "scripting", "storage"]);
  assert.doesNotMatch(manifestText, /cookies|webRequest|history/);
  assert.equal(manifest.name, "에듀파인 품의내역 브라우저 도우미");
  assert.match(manifestText, /deepsky616\.github\.io\/school-quote-review/);
  assert.match(extractor, /\[V-P01\]/);
  assert.match(extractor, /\[V-P02\]/);
  assert.match(extractor, /structured-page-data/);
  assert.match(extractor, /"__NEXT_DATA__"/);
  assert.match(extractor, /dataLayer/);
  assert.match(extractor, /JSON-LD/);
  assert.match(extractor, /_source: "L2"/);
  assert.match(extractor, /sourceUrl: location\.href/);
  assert.match(popup, /world: "MAIN"/);
  assert.match(popup, /deepsky616\.github\.io\/school-quote-review/);
  assert.match(bridge, /event\.origin !== window\.location\.origin/);
  assert.match(review, /extraction-summary/);
  assert.match(review, /item-provenance/);
  await access(new URL("../public/edufine-helper-0.2.0.zip", import.meta.url));
  await access(new URL("../public/pdf.worker.min.mjs", import.meta.url));
});

test("브라우저 도우미는 DOM보다 구조화 상품 데이터 L2를 우선하고 합계를 교차검증한다", async () => {
  const source = await readFile(new URL("../extension/extractor.js", import.meta.url), "utf8");
  const dataLayer = [{ ecommerce: { items: [
    { item_name: "비커 250mL", item_variant: "붕규산 3.3유리", quantity: 2, item_price: 2400, totalPrice: 4800 },
    { item_name: "복사용지 A4", item_variant: "500매", quantity: 1, item_price: 15000, totalPrice: 15000 },
  ] } }];
  const result = runInNewContext(source, {
    window: { dataLayer },
    document: { body: { innerText: "주문번호 ORDER-2026-001 총 결제 금액 19,800원" }, title: "주문 내역", querySelectorAll: () => [] },
    location: { hostname: "shop.example", href: "https://shop.example/order/ORDER-2026-001", pathname: "/order/ORDER-2026-001" },
    performance: { getEntriesByType: () => [{ initiatorType: "fetch", name: "https://shop.example/api/order/detail?token=secret" }] },
    URL,
  });

  assert.equal(result._source, "L2");
  assert.equal(result._extractedBy, "structured-page-data");
  assert.equal(result.items.length, 2);
  assert.deepEqual(Array.from(result.items, (item) => item.내용), ["비커 250mL", "복사용지 A4"]);
  assert.deepEqual(Array.from(result.items, (item) => item.규격), ["붕규산 3.3유리", "500매"]);
  assert.deepEqual(Array.from(result.items, (item) => item.수량), [2, 1]);
  assert.deepEqual(Array.from(result.items, (item) => item.단가), [2400, 15000]);
  assert.equal(result.paidTotal, 19800);
  assert.deepEqual(Array.from(result._warnings), []);
  assert.deepEqual(Array.from(result._diagnostics.apiCandidates), ["https://shop.example/api/order/detail"]);
  assert.ok(result._confidence >= 0.9);
});

test("GitHub Pages 정적 빌드와 배포 구성을 유지한다", async () => {
  const [viteConfig, workflow, entry] = await Promise.all([
    readFile(new URL("../vite.pages.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"),
    readFile(new URL("../pages-app/main.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(viteConfig, /base: "\/school-quote-review\/"/);
  assert.match(viteConfig, /outDir: "\.\.\/pages-dist"/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(entry, /<ReviewApp \/>/);
});

test("PDF 불러오기는 브라우저 document와 PDF 문서 변수를 충돌시키지 않는다", async () => {
  const source = await readFile(new URL("../app/fileImport.mjs", import.meta.url), "utf8");
  assert.match(source, /globalThis\.document\?\.baseURI/);
  assert.match(source, /const pdfDocument = await pdfjs\.getDocument/);
  assert.match(source, /order\._extractedBy = "pdf-text"/);
  assert.doesNotMatch(source, /const document = await pdfjs\.getDocument/);
});

test("빈 PDF도 초기화 오류 없이 글자 없음 안내까지 처리한다", async () => {
  const originalDomMatrix = globalThis.DOMMatrix;
  const originalDocument = globalThis.document;
  const originalToHex = Uint8Array.prototype.toHex;
  globalThis.DOMMatrix = class DOMMatrix {};
  globalThis.document = { baseURI: new URL("../public/", import.meta.url).href };
  Uint8Array.prototype.toHex = function toHex() { return Buffer.from(this).toString("hex"); };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  source += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const bytes = new TextEncoder().encode(source);
  const file = {
    name: "blank.pdf",
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };

  try {
    await assert.rejects(() => importPdf(file), (error) => {
      assert.match(error.message, /\[V-P02\] 글자가 없는 스캔 PDF/);
      assert.doesNotMatch(error.message, /before initialization/);
      return true;
    });
  } finally {
    if (originalDomMatrix) globalThis.DOMMatrix = originalDomMatrix;
    else delete globalThis.DOMMatrix;
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
    if (originalToHex) Uint8Array.prototype.toHex = originalToHex;
    else delete Uint8Array.prototype.toHex;
  }
});

test("만안문구 PDF 표는 상품명·판매단가·수량·합계를 위치에 맞게 읽는다", () => {
  const cell = (value, x, y) => ({ value, x, y });
  const page = [
    cell("만안문구센터", 300, 800), cell("제품명", 286, 700), cell("판매단가", 456, 700), cell("수량", 507, 700), cell("합계", 552, 700),
      cell("바닥라인테이프/", 156, 660), cell("50mm", 203, 660), cell("/", 224, 660), cell("33m", 228, 660), cell("6,800원", 456, 660), cell("10", 505, 655.5), cell("롤", 515, 655.5), cell("68,000원", 544, 660), cell("색상", 156, 648.5), cell(":", 170, 648.5), cell("검정", 176, 648.5),
      cell("1,300원", 456, 600), cell("투명테이프A급/", 156, 594), cell("48*50m", 201, 594), cell("1", 507, 595.5), cell("개", 513, 595.5), cell("1,300원", 546, 600),
      cell("900원", 459, 540), cell("열쇠고리만들기/", 156, 534), cell("전통탈", 203, 534), cell("6", 507, 535.5), cell("개", 513, 535.5), cell("5,400원", 546, 540),
      cell("머메이드지/", 156, 480), cell("A4(10매)", 190, 480), cell("3,200원", 456, 480), cell("2", 507, 475.5), cell("속", 513, 475.5), cell("6,400원", 546, 480), cell("색상", 156, 468.5), cell(":", 170, 468.5), cell("W59", 176, 468.5),
      cell("머메이드지/", 156, 420), cell("A4(10매)", 190, 420), cell("3,200원", 456, 420), cell("2", 507, 415.5), cell("속", 513, 415.5), cell("6,400원", 546, 420), cell("색상", 156, 408.5), cell(":", 170, 408.5), cell("W26", 176, 408.5),
      cell("800원", 459, 360), cell("야광스마일팔찌만들기", 156, 354), cell("179", 503, 355.5), cell("개", 517, 355.5), cell("143,200", 542, 360),
      cell("800원", 459, 300), cell("네임펜", 156, 294), cell("F/", 176, 294), cell("검정", 183, 294), cell("22", 502, 295.5), cell("자루", 512, 295.5), cell("17,600원", 544, 300),
      cell("구입총액", 477, 250), cell(":", 504, 250), cell("248,300원", 508, 250), cell("https://www.mananmungu.co.kr/", 10, 20),
  ];

  const order = mananPositionedPagesToOrder([page]);
  assert.ok(order);
  assert.equal(order.mall, "만안문구센터");
  assert.equal(order.paidTotal, 248300);
  assert.deepEqual(order.items.map((item) => item.내용), [
    "바닥라인테이프/ 50mm / 33m", "투명테이프A급/ 48*50m", "열쇠고리만들기/ 전통탈",
    "머메이드지/ A4(10매)", "머메이드지/ A4(10매)", "야광스마일팔찌만들기", "네임펜 F/ 검정",
  ]);
  assert.deepEqual(order.items.map((item) => item.규격), ["검정", "", "", "W59", "W26", "", ""]);
  assert.deepEqual(order.items.map((item) => item.단위), ["롤", "개", "개", "속", "속", "개", "자루"]);
  assert.deepEqual(order.items.map((item) => item.수량), [10, 1, 6, 2, 2, 179, 22]);
  assert.deepEqual(order.items.map((item) => item.단가), [6800, 1300, 900, 3200, 3200, 800, 800]);
  assert.deepEqual(order.items.map((item) => item.금액), [68000, 1300, 5400, 6400, 6400, 143200, 17600]);
});

test("종이 견적서 PDF는 순번 다음 상품명·수량·단가·공급가액을 행별로 읽는다", () => {
  const cell = (value, x, y, width = 10) => ({ value, x, y, width });
  const order = paperQuotePositionedPagesToOrder([[
    cell("예스24", 300, 700),
    cell("번호", 60, 600, 20), cell("품목", 220, 600, 40), cell("수량", 400, 600, 20), cell("단가", 450, 600, 20), cell("공급가액", 500, 600, 50),
    cell("1", 65, 580), cell("교사의", 90, 579, 35), cell("말", 130, 579), cell("연습", 145, 579, 20), cell("1", 407, 580), cell("15,120", 442, 579, 34), cell("원", 476, 579), cell("15,120", 500, 579, 34), cell("원", 534, 579),
    cell("2", 65, 560), cell("교사를", 90, 559, 35), cell("지키는", 130, 559, 35), cell("단단한", 170, 559, 35), cell("학급경영", 210, 559, 45), cell("2", 407, 560), cell("16,200", 442, 559, 34), cell("원", 476, 559), cell("32,400", 500, 559, 34), cell("원", 534, 559),
    cell("3", 65, 530), cell("2022 개정과 IB 교육 철학을 적용한 초등 개념기반 탐구수업·서술형평가 설계와 실", 90, 540, 285), cell("천", 90, 521, 10), cell("1", 407, 530), cell("18,900", 442, 529, 34), cell("원", 476, 529), cell("18,900", 500, 529, 34), cell("원", 534, 529),
    cell("합계", 220, 500, 20), cell("4", 407, 500), cell("66,420", 500, 500, 34), cell("원", 534, 500),
  ]]);

  assert.ok(order);
  assert.equal(order.mall, "YES24 견적서");
  assert.equal(order._extractedBy, "paper-quote-pdf-table");
  assert.equal(order.paidTotal, 66420);
  assert.deepEqual(order.items.map((item) => [item.내용, item.규격, item.단위, item.수량, item.단가, item.금액]), [
    ["교사의 말 연습", "", "권", 1, 15120, 15120],
    ["교사를 지키는 단단한 학급경영", "", "권", 2, 16200, 32400],
    ["2022 개정과 IB 교육 철학을 적용한 초등 개념기반 탐구수업·서술형평가 설계와 실천", "", "권", 1, 18900, 18900],
  ]);
  assert.deepEqual(order._warnings, []);
});

test("순번 없는 종이 견적서는 공급가액·비고 헤더 다음 품목부터 읽는다", () => {
  const cell = (value, x, y, width = 10) => ({ value, x, y, width });
  const order = paperQuotePositionedPagesToOrder([[
    cell("견적서", 40, 700),
    cell("품목", 120, 600, 30), cell("수량", 350, 600, 20), cell("단가", 420, 600, 20), cell("공급가액", 490, 600, 40), cell("비고", 550, 600, 20),
    cell("복사용지 A4", 60, 580, 75), cell("2", 356, 580), cell("12,000", 420, 580, 35), cell("원", 455, 580), cell("24,000", 500, 580, 35), cell("원", 535, 580),
    cell("네임펜 검정", 60, 560, 75), cell("3", 356, 560), cell("800", 420, 560, 18), cell("원", 438, 560), cell("2,400", 500, 560, 30), cell("원", 530, 560),
    cell("합계", 200, 540, 20), cell("26,400", 500, 540, 35), cell("원", 535, 540),
  ]]);

  assert.ok(order);
  assert.equal(order.mall, "종이 견적서·영수증");
  assert.deepEqual(order.items.map((item) => [item.내용, item.수량, item.단가, item.금액]), [
    ["복사용지 A4", 2, 12000, 24000],
    ["네임펜 검정", 3, 800, 2400],
  ]);
  assert.deepEqual(order._warnings, []);
});

test("종이 표 PDF는 열 이름 변형·분리된 머리글·규격·단위와 다음 쪽의 이어진 행을 읽는다", () => {
  const cell = (value, x, y, width = 10) => ({ value, x, y, width });
  const order = paperQuotePositionedPagesToOrder([[
    cell("일련번호", 40, 600, 30), cell("품목명", 120, 600, 40), cell("규격", 285, 600, 30),
    cell("주문수량", 355, 600, 40), cell("단위", 405, 600, 20), cell("단위가격", 445, 600, 40),
    cell("공급", 520, 600, 30), cell("가액", 520, 590, 30), cell("세액", 580, 600, 20), cell("비고", 620, 600, 20),
    cell("1", 50, 560), cell("복사용지", 80, 560, 50), cell("A4 80g", 240, 560, 45),
    cell("2", 365, 560), cell("BOX", 407, 560, 25), cell("5,000원", 450, 560, 40),
    cell("10,000원", 520, 560, 45), cell("1,000원", 580, 560, 40),
  ], [
    cell("2", 50, 680), cell("네임펜", 80, 680, 40), cell("검정", 240, 680, 25),
    cell("1", 365, 680), cell("EA", 410, 680, 15), cell("3,000원", 450, 680, 40), cell("3,000원", 520, 680, 40),
    cell("총액", 450, 650, 20), cell("13,000원", 520, 650, 45),
  ]]);

  assert.ok(order);
  assert.equal(order.paidTotal, 13000);
  assert.deepEqual(order.items.map((item) => [item.내용, item.규격, item.단위, item.수량, item.단가, item.금액]), [
    ["복사용지", "A4 80g", "박스", 2, 5000, 10000],
    ["네임펜", "검정", "개", 1, 3000, 3000],
  ]);
});

test("붙여넣은 번호·품목·수량·단가·공급가액 표는 순번을 빼고 줄바꿈 상품명을 합친다", () => {
  const order = parseOrderText([
    "번호 품목 수량 단가 공급가액",
    "1 교사의 말 연습 1 15,120원 15,120원",
    "2 질문하는 방법, 어떻게 가르칠까? 1 17,100원 17,100원",
    "3 불안 세대 1 22,320원 22,320원",
    "4 교사를 지키는 단단한 학급경영 2 16,200원 32,400원",
    "5 평가할수록 쌓이는 질문 1 13,500원 13,500원",
    "6 당신이 모르던 형성평가 이야기 1 18,000원 18,000원",
    "7 혁신적 학생평가 1 17,000원 17,000원",
    "8 중학생을 위한 수행평가 글쓰기 1 15,300원 15,300원",
    "9 AI와 과정 중심 논·서술형 평가 1 12,000원 12,000원",
    "10 서술형·논술형 평가 문항 어떻게 만들어지나? 1 18,000원 18,000원",
    "11 2022 개정과 IB 교육 철학을 적용한 초등 개념기반 탐구수업•서술형평가 설계와 실",
    "천",
    "1 18,900원 18,900원",
    "12 초등 5학년 서술형·논술형 문제집 1 1 11,520원 11,520원",
    "13 논술형 평가 특강 1 18,900원 18,900원",
    "14 서·논술형 평가 완전 정복 1 18,000원 18,000원",
    "15 완전한 과학책 4학년 1 14,400원 14,400원",
    "16 질문을 만드는 법 1 17,820원 17,820원",
    "17 질문과 평가로 깊어지는 수업 1 17,100원 17,100원",
    "합계 18 297,380원",
  ].join("\n"));

  assert.equal(order.mall, "표 형식 견적서");
  assert.equal(order.items.length, 17);
  assert.equal(order.paidTotal, 297380);
  assert.equal(order.items[0].내용, "교사의 말 연습");
  assert.equal(order.items[10].내용, "2022 개정과 IB 교육 철학을 적용한 초등 개념기반 탐구수업•서술형평가 설계와 실천");
  assert.equal(order.items[10].수량, 1);
  assert.equal(order.items[11].내용, "초등 5학년 서술형·논술형 문제집 1");
  assert.deepEqual(order.items[3], {
    내용: "교사를 지키는 단단한 학급경영", 규격: "", 단위: "개", 수량: 2, 단가: 16200, 금액: 32400,
    _rawName: "4 | 교사를 지키는 단단한 학급경영 | 2 | 16200원 | 32400원", _warnings: [], excluded: false,
  });
});

test("쇼핑몰별 주문 화면 PDF는 좌표 구조에 맞춰 상품명·할인가·배송비를 읽는다", () => {
  const cell = (value, x, y) => ({ value, x, y });

  const yes24 = yes24PositionedPagesToOrder([[
    cell("예스24", 350, 800), cell("상품명", 260, 700), cell("정가", 420, 700), cell("수량", 475, 700), cell("할인금액", 510, 700), cell("합계", 550, 700),
    cell("[도서] 완다는 별의 소리를 들어요", 192, 650), cell("15,750원", 509, 642), cell("17,500원", 419, 632), cell("2", 479, 632), cell("31,500원", 544, 632),
  ]]);
  assert.ok(yes24);
  assert.equal(yes24._extractedBy, "yes24-pdf-table");
  assert.deepEqual(yes24.items.map((item) => [item.내용, item.단위, item.수량, item.단가, item.금액]), [
    ["완다는 별의 소리를 들어요", "권", 2, 15750, 31500],
  ]);

  const gmarket = gmarketPositionedPagesToOrder([[
    cell("G마켓", 320, 800), cell("주문상품", 60, 700), cell("3", 96, 700), cell("개", 104, 700),
    cell("오리온", 119, 650), cell("초코파이", 150, 650), cell("48P 1872g(1박스)", 190, 650), cell("수량", 119, 638), cell("1", 138, 638), cell("개", 142, 638), cell("18,600", 340, 626), cell("14,880", 331, 615), cell("무료배송", 346, 590),
    cell("글라스메이트", 119, 540), cell("색연필 적 12자루 지구화학", 165, 540), cell("수량", 119, 528), cell("1", 138, 528), cell("개", 142, 528), cell("2,890", 336, 511), cell("배송비", 307, 480), cell("무료", 329, 480), cell("3,000", 348, 480), cell("원", 365, 480),
    cell("코히모", 119, 430), cell("PVC 컬러 셀로판지 10p", 145, 430), cell("사이즈", 119, 418), cell("× 총 수량 210 x 297 mm × 1세트", 145, 418), cell("수량", 119, 406), cell("5", 138, 406), cell("개", 142, 406), cell("83,500", 338, 394), cell("79,330", 330, 383), cell("무료배송", 346, 356),
  ]]);
  assert.ok(gmarket);
  assert.equal(gmarket._extractedBy, "gmarket-pdf-cards");
  assert.deepEqual(gmarket.items.map((item) => [item.내용, item.규격, item.단가]), [
    ["오리온 초코파이 48P 1872g(1박스)", "", 14880],
    ["글라스메이트 색연필 적 12자루 지구화학", "", 2890],
    ["배송비", "", 3000],
    ["코히모 PVC 컬러 셀로판지 10p", "사이즈 × 총 수량 210 x 297 mm × 1세트", 15866],
  ]);
  assert.deepEqual(gmarket.items.at(-1), {
    내용: "코히모 PVC 컬러 셀로판지 10p", 규격: "사이즈 × 총 수량 210 x 297 mm × 1세트", 단위: "개",
    수량: 5, 단가: 15866, 금액: 79330,
    _rawName: "코히모 PVC 컬러 셀로판지 10p | 사이즈 × 총 수량 210 x 297 mm × 1세트 | 수량 5개 | 79,330",
    _warnings: [], excluded: false,
  });

  const elevenStreet = elevenStreetPositionedPagesToOrder([[
    cell("11번가", 350, 800), cell("주문상품", 55, 700), cell("상품쿠폰", 112, 650), cell("적용중", 136, 650), cell("1", 304, 650), cell("개", 308, 650), cell("4,790", 354, 650), cell("3,000", 423, 650),
    cell("라팔라", 109, 632), cell("트리거 엑스 미노우웜 6인치 광어 다운샷", 134, 632), cell("옵션", 109, 615), cell("핑크 펄 UV(PKPU)", 126, 615),
  ]]);
  assert.ok(elevenStreet);
  assert.equal(elevenStreet._extractedBy, "11st-pdf-table");
  assert.deepEqual(elevenStreet.items.map((item) => [item.내용, item.규격, item.단가]), [
    ["라팔라 트리거 엑스 미노우웜 6인치 광어 다운샷", "핑크 펄 UV(PKPU)", 4790],
    ["배송비", "", 3000],
  ]);

  const teachermall = teachermallPositionedPagesToOrder([[
    cell("티처몰", 195, 770), cell("주문상품", 158, 589), cell("수량", 332, 589), cell("상품금액", 381, 589), cell("할인금액", 443, 589), cell("할인적용금액", 499, 589),
    cell("상품번호 1096994", 73, 568), cell("흡연예방&학교폭력예방 L홀더 시리즈 (디자인 택1)", 72, 559), cell("옵션", 73, 547), cell("디자인선택: 흡연예방C", 87, 548), cell("10", 335, 558), cell("6,600원", 396, 558), cell("-", 480, 557), cell("6,600", 518, 557), cell("원", 538, 557), cell("이든", 555, 568), cell("택배", 555, 557), cell("3,00", 555, 547),
    cell("상품번호 1125781", 73, 525), cell("[학토재] 디지털시민 가치 카드 - (디지털 역량, 인공지능 윤리)", 72, 516), cell("비과세", 73, 505), cell("3", 337, 516), cell("69,000원", 393, 516), cell("-", 480, 515), cell("69,000", 513, 515), cell("원", 538, 515), cell("(주)", 555, 526), cell("택배", 555, 515), cell("무료", 555, 505),
    cell("상품번호 1215097", 73, 484), cell("흡연예방 썬캐쳐(4종택1)", 72, 475), cell("옵션", 73, 463), cell("디자인: 2.완주하자", 87, 464), cell("1", 337, 474), cell("2,200원", 396, 474), cell("-", 480, 473), cell("2,200", 518, 473), cell("원", 538, 473), cell("와우", 555, 484), cell("택배", 555, 473), cell("3,00", 555, 463),
    cell("https://shop.teacherville.co.kr/order/settle", 24, 16),
  ]]);
  assert.ok(teachermall);
  assert.equal(teachermall._extractedBy, "teachermall-pdf-table");
  assert.deepEqual(teachermall.items.map((item) => [item.내용, item.규격, item.단위, item.수량, item.단가, item.금액]), [
    ["흡연예방&학교폭력예방 L홀더 시리즈 (디자인 택1)", "디자인선택: 흡연예방C", "개", 10, 660, 6600],
    ["배송비", "", "건", 1, 3000, 3000],
    ["[학토재] 디지털시민 가치 카드 - (디지털 역량, 인공지능 윤리)", "", "개", 3, 23000, 69000],
    ["흡연예방 썬캐쳐(4종택1)", "디자인: 2.완주하자", "개", 1, 2200, 2200],
    ["배송비", "", "건", 1, 3000, 3000],
  ]);
  assert.equal(teachermall.paidTotal, 83800);

  const discountedTeachermall = teachermallPositionedPagesToOrder([[
    cell("티처몰", 195, 770), cell("주문상품", 158, 589), cell("수량", 332, 589), cell("상품금액", 381, 589), cell("할인금액", 443, 589), cell("할인적용금액", 499, 589),
    cell("상품번호 1300001", 73, 568), cell("할인 적용 테스트 상품", 72, 559), cell("옵션", 73, 547), cell("파랑", 87, 548), cell("2", 335, 558), cell("10,000원", 391, 558), cell("1,000원", 454, 558), cell("9,000", 515, 557), cell("원", 538, 557), cell("판매처", 555, 568), cell("택배", 555, 557), cell("2,500", 555, 547), cell("원", 580, 547),
    cell("https://shop.teacherville.co.kr/order/settle", 24, 16),
  ]]);
  assert.ok(discountedTeachermall);
  assert.deepEqual(discountedTeachermall.items.map((item) => [item.내용, item.규격, item.수량, item.단가, item.금액]), [
    ["할인 적용 테스트 상품", "파랑", 2, 4500, 9000],
    ["배송비", "", 1, 2500, 2500],
  ]);

  const kyobo = kyoboPositionedPagesToOrder([[
    cell("교보문고", 334, 818), cell("주문상품", 104, 428),
    cell("[국내도서]돈의 속성(400쇄 리커버에디션)", 152, 366.4), cell("1", 428.8, 365.4), cell("개", 432.7, 365.4), cell("16,020", 480.1, 369.9), cell("원", 504.6, 369.9), cell("17,800", 484.9, 358.4), cell("원", 502.6, 358.4),
    cell("[보유외서]National Geographic Kids Almanac 2027", 152, 280.9), cell("1", 428.8, 279.4), cell("개", 432.7, 279.4), cell("17,600", 480.1, 284.4), cell("원", 504.6, 284.4), cell("31,680", 484.9, 272.9), cell("원", 502.6, 272.9),
    cell("[국내도서]기억의 무늬", 152, 194.4), cell("1", 428.8, 192.9), cell("개", 432.7, 192.9), cell("17,820", 480.1, 197.9), cell("원", 504.6, 197.9), cell("19,800", 484.9, 186.4), cell("원", 502.6, 186.4),
    cell("https://order.kyobobook.co.kr/order/order", 24, 16),
  ]]);
  assert.ok(kyobo);
  assert.equal(kyobo._extractedBy, "kyobo-pdf-cards");
  assert.deepEqual(kyobo.items.map((item) => [item.내용, item.규격, item.단위, item.수량, item.단가, item.금액]), [
    ["[국내도서]돈의 속성(400쇄 리커버에디션)", "", "권", 1, 16020, 16020],
    ["[보유외서]National Geographic Kids Almanac 2027", "", "권", 1, 17600, 17600],
    ["[국내도서]기억의 무늬", "", "권", 1, 17820, 17820],
  ]);
  assert.equal(kyobo.paidTotal, 51440);

  const inlineKyobo = kyoboPositionedPagesToOrder([[
    cell("교보문고", 334, 818), cell("주문상품", 104, 428),
    cell("[국내도서]돈의 속성(400쇄 리커버에디션) 1개", 152, 366.4), cell("16,020", 480.1, 369.9), cell("원", 504.6, 369.9), cell("17,800", 484.9, 358.4), cell("원", 502.6, 358.4),
    cell("[보유외서]National Geographic Kids Almanac 2027 1개", 152, 280.9), cell("17,600", 480.1, 284.4), cell("원", 504.6, 284.4), cell("31,680", 484.9, 272.9), cell("원", 502.6, 272.9),
    cell("[국내도서]기억의 무늬 1개", 152, 194.4), cell("17,820", 480.1, 197.9), cell("원", 504.6, 197.9), cell("19,800", 484.9, 186.4), cell("원", 502.6, 186.4),
    cell("https://order.kyobobook.co.kr/order/order", 24, 16),
  ]]);
  assert.ok(inlineKyobo);
  assert.deepEqual(inlineKyobo.items.map((item) => [item.내용, item.수량, item.단가, item.금액]), [
    ["[국내도서]돈의 속성(400쇄 리커버에디션)", 1, 16020, 16020],
    ["[보유외서]National Geographic Kids Almanac 2027", 1, 17600, 17600],
    ["[국내도서]기억의 무늬", 1, 17820, 17820],
  ]);

  const iscream = iscreamPositionedPagesToOrder([[
    cell("아이스크림몰", 340, 800), cell("주문상품", 43, 760), cell("3건", 94, 760),
    cell("문교", 115, 720), cell("분필 칠판지우개 청소당번", 115, 702), cell("합배송 상품", 130, 685), cell("단일상품", 115, 666), cell("/ 2개", 151, 666), cell("3,600", 115, 645), cell("원", 150, 645),
    cell("슈링클스", 115, 600), cell("클래스룸 팩 50장입_반투명(마술종이DIY)", 115, 582), cell("합배송 상품", 130, 565), cell("단일상품", 115, 546), cell("/ 2개", 151, 546), cell("60,000", 115, 525), cell("원", 155, 525),
    cell("진행 문서 화일 (재질 / 색상 선택)", 115, 480), cell("종이>노랑색", 115, 461), cell("/ 25개", 166, 461), cell("27,500", 115, 440), cell("원", 153, 440),
  ], [
    cell("상품금액", 44, 700), cell("91,100", 500, 700), cell("원", 545, 700),
  ]]);
  assert.ok(iscream);
  assert.equal(iscream._extractedBy, "iscream-pdf-cards");
  assert.deepEqual(iscream.items.map((item) => [item.내용, item.수량, item.단가, item.금액]), [
    ["문교 분필 칠판지우개 청소당번", 2, 1800, 3600],
    ["슈링클스 클래스룸 팩 50장입_반투명(마술종이DIY)", 2, 30000, 60000],
    ["진행 문서 화일 (재질 / 색상 선택)", 25, 1100, 27500],
  ]);
  assert.deepEqual(iscream.items.map((item) => item.규격), ["단일상품", "단일상품", "종이>노랑색"]);
  assert.equal(iscream.paidTotal, 91100);
  assert.deepEqual(iscream._warnings, []);

  const incompleteIscream = iscreamPositionedPagesToOrder([[
    cell("아이스크림몰", 340, 800), cell("주문상품", 43, 760), cell("3건", 94, 760),
    cell("슈링클스", 115, 700), cell("클래스룸 팩 50장입_반투명(마술종이DIY)", 115, 682), cell("단일상품", 115, 646), cell("/ 2개", 151, 646), cell("60,000", 115, 625),
  ]]);
  assert.equal(incompleteIscream, null);
});

test("복사한 주문 화면을 6개 품목 필드와 안전 경고로 정규화한다", () => {
  const order = parseOrderText([
    "주문번호 20260821-0001",
    "내용\t규격\t단위\t수량\t예상단가",
    "비커 250mL\t붕규산 유리\t개\t20\t2,400원",
    "복사용지 A4\t500매 × 5권\t박스\t1\t26,300원",
    "결제금액 74,300원",
  ].join("\n"), { sourceUrl: "https://shop.example/order/1" });

  assert.equal(order.items.length, 2);
  assert.deepEqual(
    Object.keys(order.items[0]).filter((key) => ["내용", "규격", "단위", "수량", "단가", "금액"].includes(key)),
    ["내용", "규격", "단위", "수량", "단가", "금액"],
  );
  assert.equal(order.items[0].단위, "개");
  assert.equal(order.items[0].금액, 48000);
  assert.equal(order.paidTotal, 74300);
  assert.deepEqual(order._warnings, []);
});

test("G마켓 스크랩은 상품별 수량·할인가를 맞추고 유료 배송비를 별도 품목으로 만든다", () => {
  const order = parseOrderText([
    "- \\",
    "  [1+1 살림살림 부직포 다용도 리빙박스 의류 이불 장난감 정리함](https://item.gmarket.co.kr/Item?spm=ordersheet\\&goodsCode=4076213491)",
    "  선택1+1 1세트",
    "  수량1개",
    "  쿠폰적용",
    "  **상품 금액 :7,990원**",
    "  주식회사더살림",
    "  무료배송",
    "- [30공 바인더 제본 A4 PP 타공 표지 반투명 50매](https://item.gmarket.co.kr/Item?goodsCode=3386601904)",
    "  색상반투명",
    "  수량1개",
    "  쿠폰적용",
    "  **상품 금액 :16,900**원**14,370원**",
    "  펜팬클럽",
    "  배송비3,500원",
    "- [A4 30공 똑딱 루즈리프 집게링 10mm 13mm /원터치 루즈링 투명 플라스틱 다공 셀프 제본](https://item.gmarket.co.kr/Item?goodsCode=4456450944)",
    "  색상30공 10mm 그린",
    "  수량30개",
    "  쿠폰적용",
    "  **상품 금액 :27,000원**",
    "  도움소",
    "  50,000원 이상 구매시 배송비 무료3,000원",
    "- [오리온 카스타드12P](https://item.gmarket.co.kr/Item?goodsCode=1674917474)",
    "  수량1개",
    "  스타배송내일(화) 도착보장",
    "  쿠폰적용",
    "  **상품 금액 :5,680원**",
    "  스타배송",
    "  15,000원 이상 구매시 배송비 무료3,000원",
  ].join("\n"));

  assert.deepEqual(order.items.map((item) => item.내용), [
    "1+1 살림살림 부직포 다용도 리빙박스 의류 이불 장난감 정리함",
    "30공 바인더 제본 A4 PP 타공 표지 반투명 50매",
    "배송비",
    "A4 30공 똑딱 루즈리프 집게링 10mm 13mm /원터치 루즈링 투명 플라스틱 다공 셀프 제본",
    "배송비",
    "오리온 카스타드12P",
    "배송비",
  ]);
  assert.deepEqual(order.items.map((item) => item.수량), [1, 1, 1, 30, 1, 1, 1]);
  assert.deepEqual(order.items.map((item) => item.단가), [7990, 14370, 3500, 900, 3000, 5680, 3000]);
  assert.deepEqual(order.items.map((item) => item.금액), [7990, 14370, 3500, 27000, 3000, 5680, 3000]);
  assert.equal(order.items[0].규격, "선택 1+1 1세트");
  assert.equal(order.items[1].규격, "색상 반투명");
  assert.deepEqual(order.items.filter((item) => item.내용 === "배송비").map((item) => item.규격), ["", "", ""]);
  assert.equal(order.paidTotal, 64540);
  assert.equal(order.mall, "item.gmarket.co.kr");
});

test("티처몰 주문 복사본은 중복 상품명을 제거하고 할인적용금액·옵션·배송비를 맞춘다", () => {
  const order = parseOrderText([
    "주문상품\t수량\t상품금액\t할인금액\t할인적용금액\t배송비",
    "흡연예방&학교폭력예방 L홀더 시리즈 (디자인 택1)",
    "상품번호 1096994",
    "흡연예방&학교폭력예방 L홀더 시리즈 (디자인 택1)",
    "옵션 디자인선택: 흡연예방C",
    "10\t6,600원",
    "---------",
    "6,600원",
    "이든교육",
    "택배",
    "3,000원 (선불)",
    "변경",
    "[학토재] 디지털시민 가치 카드 - (디지털 역량, 인공지능 윤리)",
    "상품번호 1125781",
    "[학토재] 디지털시민 가치 카드 - (디지털 역량, 인공지능 윤리)",
    "비과세",
    "3\t69,000원",
    "---------",
    "69,000원",
    "(주)학토재행복가게",
    "택배",
    "무료 (선불)",
    "변경",
    "흡연예방 썬캐쳐(4종택1)",
    "상품번호 1215097",
    "흡연예방 썬캐쳐(4종택1)",
    "옵션 디자인: 2.완주하자",
    "1\t2,200원",
    "--------",
    "2,200원",
    "와우노리",
    "택배",
    "3,000원 (선불)",
    "변경",
  ].join("\n"));

  assert.equal(order.mall, "티처몰");
  assert.deepEqual(order.items.map((item) => [item.내용, item.규격, item.단위, item.수량, item.단가, item.금액]), [
    ["흡연예방&학교폭력예방 L홀더 시리즈 (디자인 택1)", "디자인선택: 흡연예방C", "개", 10, 660, 6600],
    ["배송비", "", "건", 1, 3000, 3000],
    ["[학토재] 디지털시민 가치 카드 - (디지털 역량, 인공지능 윤리)", "", "개", 3, 23000, 69000],
    ["흡연예방 썬캐쳐(4종택1)", "디자인: 2.완주하자", "개", 1, 2200, 2200],
    ["배송비", "", "건", 1, 3000, 3000],
  ]);
  assert.equal(order.items.filter((item) => item.내용.includes("L홀더")).length, 1);
  assert.equal(order.paidTotal, 83800);
});

test("티처몰 필드가 줄마다 분리되어도 상품번호 뒤 상품명·옵션·수량·마지막 원 금액 순서로 읽는다", () => {
  const order = parseOrderText([
    "주문상품\t수량\t상품금액\t할인금액\t할인적용금액\t배송비",
    "앞쪽에 반복된 이름은 사용하지 않음",
    "상품번호 1300001",
    "할인 적용 테스트 상품",
    "옵션",
    "파랑",
    "2",
    "10,000원",
    "1,000원",
    "9,000원",
    "판매처",
    "택배",
    "2,500원 (선불)",
    "변경",
    "두 번째 상품 반복 표시",
    "상품번호 1300002",
    "배송비 없음 테스트 상품",
    "1",
    "5,000원",
    "5,000원",
    "판매처",
    "택배",
    "도움말",
    "3,000원",
    "변경",
  ].join("\n"));

  assert.equal(order.mall, "티처몰");
  assert.deepEqual(order.items.map((item) => [item.내용, item.규격, item.수량, item.단가, item.금액]), [
    ["할인 적용 테스트 상품", "파랑", 2, 4500, 9000],
    ["배송비", "", 1, 2500, 2500],
    ["배송비 없음 테스트 상품", "", 1, 5000, 5000],
  ]);
  assert.equal(order.items.filter((item) => item.내용 === "배송비").length, 1);
  assert.equal(order.paidTotal, 16500);
});

test("교보문고 주문 복사본은 중복 제목을 제거하고 수량 다음 할인 적용 금액을 사용한다", () => {
  const order = parseOrderText([
    "[국내도서]돈의 속성(400쇄 리커버에디션)",
    "1개\t16,020 원",
    "17,800원",
    "[보유외서]National Geographic Kids Almanac 2027",
    "[보유외서]National Geographic Kids Almanac 2027",
    "1개\t17,600 원",
    "31,680원",
    "[국내도서]기억의 무늬",
    "[국내도서]기억의 무늬",
    "1개\t17,820 원",
    "19,800원",
  ].join("\n"));

  assert.equal(order.mall, "교보문고");
  assert.deepEqual(order.items.map((item) => [item.내용, item.규격, item.단위, item.수량, item.단가, item.금액]), [
    ["[국내도서]돈의 속성(400쇄 리커버에디션)", "", "권", 1, 16020, 16020],
    ["[보유외서]National Geographic Kids Almanac 2027", "", "권", 1, 17600, 17600],
    ["[국내도서]기억의 무늬", "", "권", 1, 17820, 17820],
  ]);
  assert.equal(order.paidTotal, 51440);
});

test("교보문고 상품명과 수량이 한 줄이어도 1개를 상품명에서 빼고 첫 금액만 사용한다", () => {
  const order = parseOrderText([
    "[국내도서]돈의 속성(400쇄 리커버에디션) 1개",
    "16,020원",
    "17,800원",
    "[보유외서]National Geographic Kids Almanac 2027 1개",
    "17,600원",
    "31,680원",
    "[국내도서]기억의 무늬 1개",
    "17,820원",
    "19,800원",
  ].join("\n"));

  assert.equal(order.mall, "교보문고");
  assert.deepEqual(order.items.map((item) => [item.내용, item.규격, item.단위, item.수량, item.단가, item.금액]), [
    ["[국내도서]돈의 속성(400쇄 리커버에디션)", "", "권", 1, 16020, 16020],
    ["[보유외서]National Geographic Kids Almanac 2027", "", "권", 1, 17600, 17600],
    ["[국내도서]기억의 무늬", "", "권", 1, 17820, 17820],
  ]);
  assert.ok(order.items.every((item) => !/\s1개$/.test(item.내용)));
  assert.equal(order.paidTotal, 51440);
});

test("구조가 사라진 주문 텍스트의 수량과 가격 기준은 자동 확정하지 않는다", () => {
  const order = parseOrderText("실험용 비커 세트 24,000원\n결제금액 24,000원");
  assert.deepEqual(order.items[0]._warnings.sort(), ["V03", "V04"]);

  const ambiguous = parseOrderText("실험용 비커 세트 x 2 24,000원\n결제금액 24,000원");
  assert.ok(ambiguous.items[0]._warnings.includes("V11"));
});

test("일반 주문 텍스트의 유료 배송비도 내용 배송비인 별도 품목으로 읽는다", () => {
  const order = parseOrderText("실험용 비커 판매가 10,000원\n배송비 3,500원\n결제금액 13,500원");
  const shipping = order.items.find((item) => item.내용 === "배송비");
  assert.ok(shipping);
  assert.equal(shipping.규격, "");
  assert.equal(shipping.단위, "건");
  assert.equal(shipping.수량, 1);
  assert.equal(shipping.단가, 3500);
  assert.equal(shipping.금액, 3500);
});

test("배송 안내는 HTML 공백을 지우고 가장 오른쪽의 무료배송·배송비 결과를 적용한다", () => {
  const order = parseOrderText([
    "G마켓 https://www.gmarket.co.kr/",
    "오리온 카스타드12P",
    "수량1개",
    "상품 금액 :5,680원",
    "15,000원 이상 구매시 배송비 무료무료배송 &#x20;",
    "30공 바인더 제본 A4 PP 타공 표지 반투명 50매",
    "수량1개",
    "상품 금액 :14,370원",
    "50,000원 이상 구매시 배송비 무료3,000원 &#x20;",
  ].join("\n"));

  assert.deepEqual(order.items.map((item) => item.내용), [
    "오리온 카스타드12P",
    "30공 바인더 제본 A4 PP 타공 표지 반투명 50매",
    "배송비",
  ]);
  const shipping = order.items.at(-1);
  assert.equal(shipping.규격, "");
  assert.equal(shipping.단위, "건");
  assert.equal(shipping.수량, 1);
  assert.equal(shipping.단가, 3000);
  assert.equal(shipping.금액, 3000);
  assert.equal(order.items.some((item) => item.단가 === 15000 || item.단가 === 50000), false);
});

test("합배송 스크랩은 브랜드·상품명을 묶고 표시 금액을 수량으로 나눈다", () => {
  const order = parseOrderText([
    "문교",
    "분필 칠판지우개 청소당번",
    "합배송 상품",
    "단일상품 / 2개",
    "**3,600원**",
    "**메이세븐**",
    "50,000원 이상 무료배송",
    "슈링클스",
    "클래스룸 팩 50장입\\_반투명(마술종이DIY)",
    "합배송 상품",
    "단일상품 / 2개",
    "**60,000원**",
    "**이야코**",
    "50,000원 이상 무료배송",
    "이야코",
    "만지락 소프트 유토 100g",
    "합배송 상품",
    "단일상품 / 3개",
    "**5,940원**",
    "---",
  ].join("\n"));

  assert.deepEqual(order.items.map((item) => item.내용), [
    "문교 분필 칠판지우개 청소당번",
    "슈링클스 클래스룸 팩 50장입_반투명(마술종이DIY)",
    "이야코 만지락 소프트 유토 100g",
  ]);
  assert.deepEqual(order.items.map((item) => item.수량), [2, 2, 3]);
  assert.deepEqual(order.items.map((item) => item.단가), [1800, 30000, 1980]);
  assert.deepEqual(order.items.map((item) => item.금액), [3600, 60000, 5940]);
  assert.ok(order.items.every((item) => item.규격 === "단일상품"));
  assert.equal(order.paidTotal, 69540);
  assert.equal(order.items.some((item) => item.내용.includes("무료배송")), false);
  assert.equal(order.items.some((item) => item.내용 === "메이세븐"), false);
});

test("아이스크림몰 주문은 합배송 표시 유무와 관계없이 모든 단일상품을 읽는다", () => {
  const order = parseOrderText([
    "아이스크림몰 https://i-screammall.co.kr/",
    "(주)베어나인",
    "50,000원 이상 무료배송",
    "베어나인",
    "탁구공 토스 오목게임",
    "단일상품 / 1개",
    "11,500원",
    "메이세븐",
    "50,000원 이상 무료배송",
    "슈링클스",
    "클래스룸 팩 50장입_반투명(마술종이DIY)",
    "합배송 상품",
    "단일상품 / 2개",
    "60,000원",
    "(주) 선광오피스",
    "50,000원 이상 무료배송",
    "진행 문서 화일 (재질 / 색상 선택)",
    "종이>노랑색 / 25개",
    "27,500원",
  ].join("\n"));

  assert.deepEqual(order.items.map((item) => item.내용), [
    "베어나인 탁구공 토스 오목게임",
    "슈링클스 클래스룸 팩 50장입_반투명(마술종이DIY)",
    "진행 문서 화일 (재질 / 색상 선택)",
  ]);
  assert.deepEqual(order.items.map((item) => item.수량), [1, 2, 25]);
  assert.deepEqual(order.items.map((item) => item.단가), [11500, 30000, 1100]);
  assert.deepEqual(order.items.map((item) => item.금액), [11500, 60000, 27500]);
  assert.equal(order.items.some((item) => /무료배송|메이세븐|선광오피스/.test(item.내용)), false);
});

test("쿠팡 주문은 정가·할인율·쿠폰·적립금을 제외하고 최종 할인가와 개당가를 맞춘다", () => {
  const order = parseOrderText([
    "쿠팡 https://www.coupang.com/",
    "로켓배송 상품",
    "무료배송 · 19,800원 이상 주문 가능",
    "듀얼 모니터 받침대 수납 서랍형 거치대 와이드 모니터 거치옵션: 원목 컬러",
    "삭제",
    "4.5",
    "만족했어요 100+",
    "내일(화) 도착",
    "할인34,850원",
    "17%",
    "28,890원",
    "star starred 도톰한 레인보우 7컬러 색지(7 COLORED PAPER)옵션: 120g A4 140매, A4",
    "삭제",
    "한달구매 100+",
    "내일(화) 도착",
    "쿠폰할인18,000원",
    "28%",
    "12,870원",
    "130원 쿠폰할인 적용됨",
    "스포틀러 안티버스트 짐볼 + 고급 에어펌프옵션: 마블핑크, 25cm",
    "삭제",
    "한달구매 400+",
    "내일(화) 도착",
    "16,000원",
    "38%",
    "9,800원",
    "애플 칭찬 스탬프 6종 세트옵션: 레드,핑크,블루,블랙,그린,퍼플, 1세트",
    "삭제",
    "만족했어요 900+",
    "내일(화) 도착",
    "57,200원",
    "(1개당 14,300원)",
    "스포틀러 NBR 요가매트 + 전용 스트랩옵션: 차밍퍼플, 와이드 16mm(800 x 1830 mm), 1개",
    "삭제",
    "품절임박 ∙ 3개 남음",
    "내일(화) 도착",
    "78,000원",
    "38%",
    "48,000원",
    "(1개당 24,000원)",
    "1,644원캐시적립",
    "Wllhot EVA 고밀도 폼롤러 근막이완 마사지 롤러 근육 이완 스트레칭 요가 필라테스 홈트 운동 회복 전신 마사지옵션: 1개, 60×10cm, 퍼플",
    "삭제",
    "내일(화) 도착",
    "할인79,600원",
    "55%",
    "35,600원",
    "(1개당 17,800원)",
  ].join("\n"));

  assert.equal(order.items.length, 6);
  assert.deepEqual(order.items.map((item) => item.수량), [1, 1, 1, 4, 2, 2]);
  assert.deepEqual(order.items.map((item) => item.단가), [28890, 12870, 9800, 14300, 24000, 17800]);
  assert.deepEqual(order.items.map((item) => item.금액), [28890, 12870, 9800, 57200, 48000, 35600]);
  assert.equal(order.items[1].내용.startsWith("star starred"), false);
  assert.equal(order.items.some((item) => /할인|쿠폰|캐시|무료배송/.test(item.내용)), false);
});

test("G마켓 일반 붙여넣기는 취소선 정가보다 마지막 할인 상품금액을 사용하고 배송비를 분리한다", () => {
  const order = parseOrderText([
    "G마켓 https://www.gmarket.co.kr/",
    "오리온 카스타드12P",
    "수량1개",
    "스타배송",
    "내일(화) 도착보장",
    "쿠폰적용",
    "상품 금액 :",
    "5,680원",
    "4,550원",
    "스타배송",
    "15,000원 이상 구매시 배송비 무료3,000원",
    "파워라인 형광펜 노랑 12자루 자바펜",
    "수량1개",
    "쿠폰적용",
    "상품 금액 :",
    "2,560원",
    "오피스디포",
    "50,000원 이상 구매시 배송비 무료3,000원",
    "국산 투명 PE 지퍼백 비닐팩 벌크 7x10 미니 100매",
    "수량1개",
    "쿠폰적용",
    "상품 금액 :",
    "1,900원",
    "플러스shop",
    "배송비3,000원",
    "메디와이퍼 의약외품 소독티슈 80매(캡형)x10팩 항 균 식약처인증",
    "수량1개",
    "쿠폰적용",
    "상품 금액 :",
    "24,900원",
    "22,410원",
    "GS_SHOP",
    "무료배송",
  ].join("\n"));

  assert.deepEqual(order.items.map((item) => item.내용), [
    "오리온 카스타드12P", "배송비",
    "파워라인 형광펜 노랑 12자루 자바펜", "배송비",
    "국산 투명 PE 지퍼백 비닐팩 벌크 7x10 미니 100매", "배송비",
    "메디와이퍼 의약외품 소독티슈 80매(캡형)x10팩 항 균 식약처인증",
  ]);
  assert.deepEqual(order.items.map((item) => item.단가), [4550, 3000, 2560, 3000, 1900, 3000, 22410]);
  assert.deepEqual(order.items.filter((item) => item.내용 === "배송비").map((item) => item.규격), ["", "", ""]);
  assert.equal(order.items.some((item) => /쿠폰적용|스타배송|GS_SHOP|플러스shop/.test(item.내용)), false);
});

test("같은 상품명이 연속으로 반복되면 내용에는 한 번만 작성한다", () => {
  const order = parseOrderText([
    "오리온 초코파이 48P 1872g(1박스)",
    "오리온 초코파이 48P 1872g(1박스)",
    "수량1개",
    "스타배송",
    "내일(수) 도착보장",
    "쿠폰적용",
    "상품 금액 :",
    "18,600원",
    "14,880원",
    "스타배송",
    "15,000원 이상 구매시 배송비 무료무료배송",
    "",
    "글라스메이트 색연필 적 12자루 지구화학",
    "글라스메이트 색연필 적 12자루 지구화학",
    "수량1개",
    "쿠폰적용",
    "상품 금액 :2,890원",
    "오피스디포",
    "50,000원 이상 구매시 배송비 무료3,000원",
  ].join("\n"));

  assert.deepEqual(order.items.map((item) => item.내용), [
    "오리온 초코파이 48P 1872g(1박스)",
    "글라스메이트 색연필 적 12자루 지구화학",
    "배송비",
  ]);
  assert.deepEqual(order.items.map((item) => item.단가), [14880, 2890, 3000]);
  assert.equal(order.items.at(-1).규격, "");
});

test("11번가 주문은 할인모음가·옵션·선결제 배송비를 품목에 맞게 읽는다", () => {
  const order = parseOrderText([
    "11번가: [https://www.11st.co.kr/](https://www.11st.co.kr/)",
    "### 스토어명 앵글러피싱",
    "-",
    "* 상품쿠폰 적용중",
    "* [라팔라 트리거 엑스 미노우웜 6인치 광어 다운샷](https://www.11st.co.kr/products/9518750887?xzone=order^list\\&xfrom=order^list\\&stockNo=46912457660)",
    "- 옵션핑크 펄 UV(PKPU)",
    "- 내일 8/26(수) 도착",
    "도움말",
    "1개",
    "할인모음가",
    "4,790&#xC6D0;",
    "판매가",
    "5,300원",
    "선결제",
    "3,000원",
    "배송정보",
    "배송비",
    "도움말",
    "### 스토어명 삼성공식파트너_피트존",
    "* [삼성전자 SL-C563W 토너포함 컬러레이저복합기 무선 프린터기 가정용 스캐너 복사기 인쇄기](https://www.11st.co.kr/products/1539505037?xzone=order^list\\&xfrom=order^list\\&stockNo=6258733859)",
    "- 내일 8/26(수) 도착",
    "도움말",
    "1개",
    "할인모음가",
    "367,000&#xC6D0;",
    "배송정보",
    "무료배송",
    "도움말",
    "### 스토어명 레고공식스토어",
    "* [레고 디즈니 프린세스 43291 벨과 티아나의 성](https://www.11st.co.kr/products/8978118228?xzone=order^list\\&xfrom=order^list\\&stockNo=43967141426)",
    "- 모레 8/27(목) 도착",
    "도움말",
    "1개",
    "할인모음가",
    "54,900&#xC6D0;",
    "배송정보",
    "무료배송",
    "도움말",
  ].join("\n"));

  assert.equal(order.mall, "11번가");
  assert.deepEqual(order.items.map((item) => item.내용), [
    "라팔라 트리거 엑스 미노우웜 6인치 광어 다운샷",
    "배송비",
    "삼성전자 SL-C563W 토너포함 컬러레이저복합기 무선 프린터기 가정용 스캐너 복사기 인쇄기",
    "레고 디즈니 프린세스 43291 벨과 티아나의 성",
  ]);
  assert.deepEqual(order.items.map((item) => item.규격), ["핑크 펄 UV(PKPU)", "", "", ""]);
  assert.deepEqual(order.items.map((item) => item.단위), ["개", "건", "개", "개"]);
  assert.deepEqual(order.items.map((item) => item.수량), [1, 1, 1, 1]);
  assert.deepEqual(order.items.map((item) => item.단가), [4790, 3000, 367000, 54900]);
  assert.equal(order.items.some((item) => item.단가 === 5300), false);
  assert.equal(order.sourceUrl, "https://www.11st.co.kr/products/9518750887?xzone=order^list&xfrom=order^list&stockNo=46912457660");
});

test("YES24 표는 정가와 포인트가 아닌 할인금액을 단가로, 합계를 금액으로 읽는다", () => {
  const order = parseOrderText([
    "yes24 https://www.yes24.com/",
    "상품명\t정가\t수량\t할인금액\t합계\t배송일",
    "\t[도서] 완다는 별의 소리를 들어요 새창소득공제\t17,500원\t2\t15,750원(10%할인)YES포인트870원\t31,500원\t8/25(화) 도착예정",
    "\t[도서] 오늘도 헤엄치는 법 새창소득공제\t16,800원\t2\t15,120원(10%할인)YES포인트840원\t30,240원\t2일 이내",
    "\t[도서] 화가 나면 열을 세어 봐 새창소득공제\t14,000원\t2\t12,600원(10%할인)YES포인트700원\t25,200원\t8/25(화)",
    "\t[도서] 양들은 지금 파업 중 새창소득공제\t15,000원\t2\t13,500원(10%할인)YES포인트750원\t27,000원\t2일 이내",
    "\t[도서] 오리털 홀씨 새창소득공제\t16,000원\t2\t15,200원(5%할인)YES포인트480원\t30,400원\t2일 이내",
  ].join("\n"));

  assert.deepEqual(order.items.map((item) => item.내용), [
    "완다는 별의 소리를 들어요",
    "오늘도 헤엄치는 법",
    "화가 나면 열을 세어 봐",
    "양들은 지금 파업 중",
    "오리털 홀씨",
  ]);
  assert.deepEqual(order.items.map((item) => item.단가), [15750, 15120, 12600, 13500, 15200]);
  assert.deepEqual(order.items.map((item) => item.금액), [31500, 30240, 25200, 27000, 30400]);
  assert.ok(order.items.every((item) => item.단위 === "권" && item.수량 === 2));
});

test("YES24 다중행 복사는 도서 제목과 수량·할인단가·합계를 순서대로 읽는다", () => {
  const order = parseOrderText([
    "[도서] 완다는 별의 소리를 들어요 새창",
    "소득공제",
    "17,500원\t2\t15,750원",
    "(10%할인)",
    "YES포인트870원",
    "31,500원",
    "8/26(수)",
    "도착예정",
    "```",
    "[도서] 오늘도 헤엄치는 법 새창",
    "```",
    "소득공제",
    "16,800원\t2\t15,120원",
    "(10%할인)",
    "YES포인트840원",
    "30,240원",
    "2일 이내",
    "(8/27, 목)",
    "출고예정",
    "안내",
    "[도서] 김밥의 탄생 새창",
    "소득공제",
    "17,000원\t2\t15,300원",
    "(10%할인)",
    "YES포인트850원",
    "30,600원",
    "8/26(수)",
    "도착예정",
  ].join("\n"));

  assert.equal(order.mall, "YES24");
  assert.deepEqual(order.items.map((item) => item.내용), [
    "완다는 별의 소리를 들어요",
    "오늘도 헤엄치는 법",
    "김밥의 탄생",
  ]);
  assert.deepEqual(order.items.map((item) => item.수량), [2, 2, 2]);
  assert.deepEqual(order.items.map((item) => item.단가), [15750, 15120, 15300]);
  assert.deepEqual(order.items.map((item) => item.금액), [31500, 30240, 30600]);
  assert.ok(order.items.every((item) => item.단위 === "권" && item.규격 === "도서"));
  assert.equal(order.items.some((item) => /YES포인트|소득공제|도착|출고/.test(item.내용)), false);
});

test("엑셀 견적서 헤더와 합계를 읽고 순번 열은 품목에서 제외한다", () => {
  const order = spreadsheetRowsToOrder([
    ["순번", "내용", "규격", "단위", "수량", "예상단가", "예상금액"],
    [1, "비커 250mL", "붕규산", "개", 2, 2400, 4800],
    [2, "복사용지 A4", "500매", "박스", 1, 26300, 26300],
    [null, "합계", null, null, null, null, 31100],
  ], "학교견적.xlsx");

  assert.equal(order.items.length, 2);
  assert.equal(order.items[0].내용, "비커 250mL");
  assert.equal(order.items[1].단위, "박스");
  assert.equal(order.paidTotal, 31100);
  assert.deepEqual(order._warnings, []);
});
