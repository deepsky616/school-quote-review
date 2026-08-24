const asPositiveNumber = (value) => {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
};

const words = (value) => String(value ?? "")
  .toLowerCase()
  .replace(/[^0-9a-z가-힣]+/g, " ")
  .split(/\s+/)
  .filter((word) => word.length >= 2);

export function chooseCapturedProductCandidate(items, hintName = "") {
  if (!Array.isArray(items)) throw new Error("[V-P02] 캡처에서 상품 후보를 찾지 못했습니다.");
  const hintWords = new Set(words(hintName));
  const candidates = items.flatMap((row, index) => {
    if (!row || typeof row !== "object") return [];
    const name = String(row["내용"] ?? "").trim();
    const quantity = Math.max(1, asPositiveNumber(row["수량"]) || 1);
    const amount = asPositiveNumber(row["금액"]);
    const unitPrice = asPositiveNumber(row["단가"]) || (amount ? Math.round(amount / quantity) : 0);
    const rawName = String(row._rawName ?? name).trim();
    if (name.length < 2 || !unitPrice) return [];

    const combined = `${name} ${rawName}`;
    let score = Math.min(name.length, 80) + Math.min(rawName.length, 80) * 0.15;
    if (/(?:판매가|상품가|상품금액|예상단가|단가)\s*[:：]?/i.test(rawName)) score += 45;
    if (/\d[\d,]*\s*원|₩\s*\d/i.test(rawName)) score += 12;
    if (/(?:쿠폰|카드\s*할인|적립|배송비|무료배송|최대\s*혜택|월\s*납부|무이자|원가|정가)/i.test(combined)) score -= 65;
    if (/(?:로그인|회원가입|검색|장바구니|구매하기|찜하기|리뷰|문의|판매자)/i.test(name)) score -= 35;
    for (const word of words(name)) if (hintWords.has(word)) score += 18;

    return [{ index, name, quantity, unitPrice, rawName, score }];
  });

  if (!candidates.length) throw new Error("[V-P02] 캡처에서 상품명과 가격을 찾지 못했습니다. 상품명과 판매가가 크게 보이도록 다시 선택해 주세요.");
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return { ...candidates[0], candidateCount: candidates.length };
}
