const allowedSelectors = new Set([
  "#txtCode3601",
  "#txtCode4006",
  "#txtCode4028",
  "#txtCode4102"
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ETAX_APPLY_SIGNED_PAYLOAD") return false;

  applySignedPayload(message.envelope)
    .then((count) => sendResponse({ message: `Applied ${count} visible field(s). Review every value before submitting.` }))
    .catch((error) => sendResponse({ message: error.message || "Payload verification failed." }));
  return true;
});

async function applySignedPayload(envelope) {
  if (!envelope || typeof envelope.sha256 !== "string" || !envelope.payload || typeof envelope.payload !== "object") {
    throw new Error("Payload envelope is incomplete.");
  }

  const canonical = JSON.stringify(sortObject(envelope.payload));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== envelope.sha256.toLowerCase()) {
    throw new Error("Payload checksum does not match.");
  }

  let filled = 0;
  for (const [selector, value] of Object.entries(envelope.payload.fields || {})) {
    if (!allowedSelectors.has(selector) || typeof value !== "string") continue;
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || input.disabled) continue;

    const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    filled += 1;
  }
  if (filled === 0) throw new Error("No matching enabled source-code fields were found.");
  return filled;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}
