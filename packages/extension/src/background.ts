/// <reference types="chrome" />
/**
 * Service worker: busca imagens sem as restrições de CORS da página
 * (host_permissions <all_urls>), tira screenshots da aba e envia capturas
 * ao relay WebSocket — tudo fora do alcance da CSP da página.
 */
import { RELAY_URL } from "@h2f/shared";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "h2f-fetch" && typeof msg.url === "string") {
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
  }

  if (msg?.type === "h2f-screenshot") {
    (async () => {
      const windowId = sender.tab?.windowId;
      try {
        const dataUrl = await captureThrottled(windowId);
        sendResponse({ ok: true, dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "h2f-relay-send" && typeof msg.json === "string") {
    // Aberto pelo service worker: imune à CSP connect-src da página.
    relaySend(msg.json).then((ok) => sendResponse({ ok }));
    return true;
  }
});

/** Tenta entregar a captura ao relay local; resolve false se ele não estiver no ar. */
function relaySend(json: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(RELAY_URL);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
      // fecha após o flush quando deu certo; imediatamente quando falhou
      try {
        ok ? setTimeout(() => ws.close(), 250) : ws.close();
      } catch { /* já fechado */ }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.onopen = () => {
      try {
        ws.send(json);
        finish(true);
      } catch {
        finish(false);
      }
    };
    ws.onerror = () => finish(false);
  });
}

/**
 * captureVisibleTab é limitado (~2 chamadas/s). Serializamos as chamadas e
 * tentamos de novo após o erro de quota antes de desistir.
 */
let captureChain: Promise<unknown> = Promise.resolve();
function captureThrottled(windowId?: number): Promise<string> {
  const run = async (): Promise<string> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return windowId != null
          ? await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
          : await chrome.tabs.captureVisibleTab({ format: "png" });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (!/MAX_CAPTURE|quota/i.test(m) || attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw new Error("captureVisibleTab falhou");
  };
  const next = captureChain.then(run, run);
  captureChain = next.catch(() => {});
  return next;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
