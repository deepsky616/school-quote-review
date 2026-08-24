const APP_URL = "https://school-quote-review.climbing1126.chatgpt.site";
const captureButton = document.querySelector("#capture");
const status = document.querySelector("#status");

function setStatus(message, kind = "") {
  status.textContent = message;
  status.className = `status ${kind}`;
}

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  setStatus("주문 품목을 확인하고 있어요…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url ?? "")) {
      throw new Error("쇼핑몰의 주문내역 웹페이지에서 실행해 주세요.");
    }
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["extractor.js"] });
    const payload = injection?.result;
    if (!payload || payload.error) throw new Error(payload?.error ?? "주문내역을 읽지 못했습니다.");
    await chrome.storage.local.set({ quoteReviewCapture: { payload, capturedAt: new Date().toISOString() } });
    setStatus(`${payload.items.length}개 품목을 가져왔어요. 검수 화면을 여는 중입니다.`, "success");
    await chrome.tabs.create({ url: APP_URL });
    window.setTimeout(() => window.close(), 500);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "주문내역을 읽지 못했습니다.", "error");
    captureButton.disabled = false;
  }
});
