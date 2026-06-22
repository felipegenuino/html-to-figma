/// <reference types="chrome" />

/**
 * Entrega a captura ao plugin do Figma. Tenta primeiro o relay WebSocket local
 * (via service worker, fora da CSP da página); se não estiver no ar, devolve
 * false para o chamador cair no clipboard.
 *
 * @returns "relay" se enviado pelo servidor, "none" se o relay não respondeu.
 */
export async function deliverViaRelay(json: string): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: "h2f-relay-send", json });
    return !!res?.ok;
  } catch {
    return false;
  }
}
