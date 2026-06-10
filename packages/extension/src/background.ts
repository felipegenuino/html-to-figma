/// <reference types="chrome" />
/**
 * Service worker: busca imagens sem as restrições de CORS da página
 * (host_permissions <all_urls>) e devolve como data URL.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "h2f-fetch" || typeof msg.url !== "string") return;
  (async () => {
    try {
      const res = await fetch(msg.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
      const buf = await res.arrayBuffer();
      sendResponse({ ok: true, dataUrl: `data:${type};base64,${toBase64(buf)}` });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // resposta assíncrona
});

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
