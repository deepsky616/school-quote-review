import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  elevenStreetPositionedPagesToOrder,
  gmarketPositionedPagesToOrder,
  importPdf,
  iscreamPositionedPagesToOrder,
  mananPositionedPagesToOrder,
  spreadsheetRowsToOrder,
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
  assert.match(html, /견적정리/);
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
  const [source, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/ReviewApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
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
  assert.match(source, /V15: "예산 한도 초과"/);
  assert.match(source, /blockingRules = new Set\(\["V01", "V02", "V04", "V05", "V07", "V11", "V12", "V15"\]\)/);
  assert.match(source, /stage === "pre-purchase"/);
  assert.match(source, /new Blob\(\[bytes\.buffer as ArrayBuffer\]/);
  assert.match(layout, /new URL\("\/og\.png", base\)/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
});

test("스텝 1을 주문 화면 붙여넣기·PDF 문서·종이 문서 탭으로 구분하고 도우미를 보조 경로로 둔다", async () => {
  const [dialog, review, manifestText, extractor, bridge] = await Promise.all([
    readFile(new URL("../app/ImportDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ReviewApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../extension/extractor.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/bridge.js", import.meta.url), "utf8"),
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
  assert.match(review, /클립보드에서 붙여넣기/);
  assert.match(review, /지원 쇼핑몰 주문 화면 바로가기/);
  assert.match(review, /https:\/\/i-screammall\.co\.kr\//);
  assert.match(review, /https:\/\/mc\.coupang\.com\/ssr\/desktop\/order\/list/);
  assert.match(review, /https:\/\/myg\.gmarket\.co\.kr\//);
  assert.match(review, /https:\/\/www\.yes24\.com\/Member\/FTMypageMain\.aspx/);
  assert.match(review, /https:\/\/www\.11st\.co\.kr\//);
  assert.match(review, /https:\/\/www\.mananmungu\.co\.kr\/mall\/index\.php/);
  assert.match(review, /장바구니·주문내역 PDF/);
  assert.match(review, /자동 품목 구분은 위에 표시된 쇼핑몰 주문 화면을 기준으로 최적화/);
  assert.match(review, /다른 쇼핑몰은 값이 빠지거나 잘못 연결될 수 있으므로/);
  assert.match(review, /복사 붙여넣기와 PDF 방법 비교/);
  assert.match(review, /YES24·G마켓·아이스크림몰·11번가·만안문구센터 예시 구조/);
  assert.match(review, /자동 수집하지 않습니다/);
  assert.doesNotMatch(review, /상품 링크를 한 줄에 하나씩|상품 초안 만들기|현재 화면 보내기|getDisplayMedia/);
  assert.match(dialog, /useState<ImportMode>\("paste"\)/);
  assert.match(dialog, /아이스크림몰 · 쿠팡 · G마켓 · YES24 · 11번가 자동 구분/);
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
  assert.match(extractor, /\[V-P01\]/);
  assert.match(extractor, /\[V-P02\]/);
  assert.match(extractor, /sourceUrl: location\.href/);
  assert.match(bridge, /event\.origin !== window\.location\.origin/);
  await access(new URL("../public/gyeonjeok-helper.zip", import.meta.url));
  await access(new URL("../public/pdf.worker.min.mjs", import.meta.url));
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
    cell("G마켓", 320, 800), cell("주문상품", 60, 700),
    cell("오리온", 119, 650), cell("초코파이", 150, 650), cell("48P 1872g(1박스)", 190, 650), cell("수량", 119, 638), cell("1", 138, 638), cell("개", 142, 638), cell("18,600", 340, 626), cell("14,880", 331, 615), cell("무료배송", 346, 590),
    cell("글라스메이트", 119, 540), cell("색연필 적 12자루 지구화학", 165, 540), cell("수량", 119, 528), cell("1", 138, 528), cell("개", 142, 528), cell("2,890", 336, 511), cell("배송비", 307, 480), cell("무료", 329, 480), cell("3,000", 348, 480), cell("원", 365, 480),
  ]]);
  assert.ok(gmarket);
  assert.equal(gmarket._extractedBy, "gmarket-pdf-cards");
  assert.deepEqual(gmarket.items.map((item) => [item.내용, item.규격, item.단가]), [
    ["오리온 초코파이 48P 1872g(1박스)", "", 14880],
    ["글라스메이트 색연필 적 12자루 지구화학", "", 2890],
    ["배송비", "", 3000],
  ]);

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

  const iscream = iscreamPositionedPagesToOrder([[
    cell("아이스크림몰", 340, 800), cell("주문상품", 43, 760), cell("슈링클스", 115, 700), cell("클래스룸 팩 50장입_반투명(마술종이DIY)", 115, 682), cell("합배송 상품", 130, 665), cell("단일상품", 115, 646), cell("/ 2개", 151, 646), cell("60,000", 115, 625), cell("원", 155, 625),
  ]]);
  assert.ok(iscream);
  assert.equal(iscream._extractedBy, "iscream-pdf-cards");
  assert.deepEqual(iscream.items.map((item) => [item.내용, item.수량, item.단가, item.금액]), [
    ["슈링클스 클래스룸 팩 50장입_반투명(마술종이DIY)", 2, 30000, 60000],
  ]);
  assert.deepEqual(iscream._warnings, []);
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
