const statusNode = document.getElementById("status");

document.getElementById("apply").addEventListener("click", async () => {
  statusNode.textContent = "";
  let envelope;
  try {
    envelope = JSON.parse(document.getElementById("payload").value);
  } catch {
    statusNode.textContent = "Payload is not valid JSON.";
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https:\/\/([^/]+\.)?(sarsefiling\.co\.za|sars\.gov\.za)\//i.test(tab.url)) {
    statusNode.textContent = "Open an official SARS eFiling tab first.";
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "ETAX_APPLY_SIGNED_PAYLOAD",
      envelope
    });
    statusNode.textContent = result?.message || "No response from the eFiling companion.";
  } catch {
    statusNode.textContent = "Could not reach the page companion. Reload the eFiling tab and try again.";
  }
});
