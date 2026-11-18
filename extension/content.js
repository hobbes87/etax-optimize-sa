(() => {
  const marker = document.createElement("meta");
  marker.name = "etaxoptimize-sa";
  marker.content = "1";
  document.head.appendChild(marker);

  chrome.storage.local.set({
    extensionPageUrl: location.href,
    detectedAt: new Date().toISOString()
  });
})();