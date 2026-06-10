/// <reference types="chrome" />
import { capture } from "./capture";
import { startPicker } from "./picker";

// Proteção contra dupla injeção (o popup injeta sob demanda)
declare global {
  interface Window {
    __h2fInjected?: boolean;
  }
}

if (!window.__h2fInjected) {
  window.__h2fInjected = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "capture-page") {
      capture(document.body)
        .then((doc) => sendResponse({ ok: true, json: JSON.stringify(doc) }))
        .catch((e) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
        );
      return true; // resposta assíncrona
    }
    if (msg?.type === "start-picker") {
      startPicker();
      sendResponse({ ok: true });
    }
  });
}
