chrome.runtime.onInstalled.addListener((details) => {
  console.log("Figloo installed:", details.reason);
});
