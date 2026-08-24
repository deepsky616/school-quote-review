window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.type !== "QUOTE_REVIEW_REQUEST_CAPTURE") return;

  const { quoteReviewCapture } = await chrome.storage.local.get("quoteReviewCapture");
  window.postMessage({
    type: "QUOTE_REVIEW_CAPTURE_RESULT",
    source: "quote-review-extension",
    payload: quoteReviewCapture?.payload,
    error: quoteReviewCapture?.payload
      ? undefined
      : "저장된 주문내역이 없습니다. 쇼핑몰 주문내역 화면에서 도우미를 먼저 실행해 주세요.",
  }, window.location.origin);
});
