/// <reference types="chrome" />
import { deliverViaRelay } from "./transport";

const statusEl = document.getElementById("status")!;

function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "";
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Nenhuma aba ativa");
  return tab;
}

/** Injeta o content script (idempotente — ele se protege contra dupla injeção). */
async function inject(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

document.getElementById("capture-page")!.addEventListener("click", async () => {
  try {
    setStatus("Capturando…");
    const tab = await activeTab();
    await inject(tab.id!);
    const res: { ok: boolean; json?: string; error?: string } =
      await chrome.tabs.sendMessage(tab.id!, { type: "capture-page" });
    if (!res.ok) throw new Error(res.error ?? "Falha na captura");
    // Relay local primeiro (sem limite de tamanho); senão, clipboard.
    if (await deliverViaRelay(res.json!)) {
      setStatus("✓ Enviado ao Figma via servidor.");
    } else {
      // Clipboard é escrito aqui no popup, que tem foco (content script não tem).
      await navigator.clipboard.writeText(res.json!);
      setStatus("✓ Copiado! Cole no plugin do Figma.");
    }
  } catch (e) {
    setStatus(String(e instanceof Error ? e.message : e), true);
  }
});

document.getElementById("pick-element")!.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    await inject(tab.id!);
    await chrome.tabs.sendMessage(tab.id!, { type: "start-picker" });
    window.close(); // o picker assume na página
  } catch (e) {
    setStatus(String(e instanceof Error ? e.message : e), true);
  }
});
