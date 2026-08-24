import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { spreadsheetRowsToOrder } from "../app/fileImport.mjs";
import { createBookmarklet, decodeBookmarkletCapture, normalizeShoppingUrl } from "../app/linkImport.mjs";
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
  assert.match(html, /쇼핑몰 장바구니·주문 링크로 시작하세요/);
  assert.match(html, /아직 불러온 품목이 없어요/);
  assert.match(html, /정확하게 가져오는 권장 순서/);
  assert.match(html, /K-에듀파인 등록/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("검수·저장·xlsx 안전 규칙을 제품 코드에 유지한다", async () => {
  const [source, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/ReviewApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(source, /Array\.from\(\{ length: 18 \}/);
  assert.match(source, /IF\(E\$\{rowNo\}=\"\",\"\",E\$\{rowNo\}\*F\$\{rowNo\}\)/);
  assert.match(source, /SUM\(G8:G25\)/);
  assert.match(source, /Math\.ceil\(included\.length \/ 18\)/);
  assert.match(source, /<t>순번<\/t>/);
  assert.match(source, /<t>예상단가<\/t>/);
  assert.match(source, /<t>예상금액<\/t>/);
  assert.match(source, /pages\.length > 1/);
  assert.match(source, /전체 합계/);
  assert.match(source, /order\.reviewed\.json/);
  assert.match(source, /excluded: item\.excluded/);
  assert.match(source, /sourceUrl: meta\.sourceUrl/);
  assert.match(source, /new Blob\(\[bytes\.buffer as ArrayBuffer\]/);
  assert.match(layout, /new URL\("\/og\.png", base\)/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
});

test("링크와 문서·사진을 우선하고 텍스트 붙여넣기는 보조 경로로 둔다", async () => {
  const [dialog, review, linkImport, manifestText, extractor, bridge] = await Promise.all([
    readFile(new URL("../app/ImportDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ReviewApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/linkImport.mjs", import.meta.url), "utf8"),
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../extension/extractor.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/bridge.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.match(review, /장바구니·주문 링크로 시작하세요/);
  assert.match(review, /견적정리로 보내기/);
  assert.match(linkImport, /credentials: "omit"/);
  assert.match(linkImport, /\[itemtype\*='Product'\]/);
  assert.match(linkImport, /#quote-import=/);
  assert.match(linkImport, /V11/);
  assert.match(dialog, /텍스트 붙여넣기는 마지막 수단/);
  assert.match(dialog, /PDF·엑셀 견적서·장바구니 캡처/);
  assert.match(dialog, /\.pdf,\.xlsx,\.xls,\.png,\.jpg/);
  assert.match(dialog, /원본 주문 링크/);
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

test("쇼핑 링크와 무설치 북마크 전달 형식을 안전하게 제한한다", () => {
  assert.equal(normalizeShoppingUrl("https://shop.example/order/1#payment"), "https://shop.example/order/1");
  assert.throws(() => normalizeShoppingUrl("javascript:alert(1)"), /http 또는 https/);
  assert.throws(() => normalizeShoppingUrl("http://127.0.0.1/order"), /공개 쇼핑몰/);

  const bookmarklet = createBookmarklet("https://quote.example/");
  assert.match(bookmarklet, /^javascript:/);
  assert.doesNotThrow(() => new Function(bookmarklet.slice("javascript:".length)));

  const order = { sourceUrl: "https://shop.example/order/1", items: [{ 내용: "비커", 수량: 2, 단가: 2400, 금액: 4800 }] };
  const encoded = Buffer.from(JSON.stringify({ order }), "utf8").toString("base64url");
  assert.deepEqual(decodeBookmarkletCapture(`#quote-import=${encoded}`), order);
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

test("구조가 사라진 주문 텍스트의 수량과 가격 기준은 자동 확정하지 않는다", () => {
  const order = parseOrderText("실험용 비커 세트 24,000원\n결제금액 24,000원");
  assert.deepEqual(order.items[0]._warnings.sort(), ["V03", "V04"]);

  const ambiguous = parseOrderText("실험용 비커 세트 x 2 24,000원\n결제금액 24,000원");
  assert.ok(ambiguous.items[0]._warnings.includes("V11"));
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
