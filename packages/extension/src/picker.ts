import { capture } from "./capture";

/**
 * Modo de seleção de elemento: highlight no hover, clique captura,
 * Esc cancela. Copia o JSON direto do content script (a página tem
 * foco após o clique, então navigator.clipboard funciona).
 */
export function startPicker() {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    background: "rgba(13, 153, 255, 0.2)",
    border: "2px solid #0d99ff",
    borderRadius: "2px",
    transition: "all 40ms linear",
  });
  document.documentElement.appendChild(overlay);

  let current: Element | null = null;

  function onMove(e: MouseEvent) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
  }

  async function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    cleanup();
    if (!current) return;
    try {
      const doc = await capture(current);
      await copyText(JSON.stringify(doc));
      toast("✓ Copiado! Cole no plugin do Figma.");
    } catch (err) {
      toast("Erro na captura: " + (err instanceof Error ? err.message : err), true);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") cleanup();
  }

  function cleanup() {
    overlay.remove();
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("keydown", onKey, true);
  }

  addEventListener("mousemove", onMove, true);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey, true);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback para páginas que bloqueiam a Clipboard API
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function toast(msg: string, isError = false) {
  const el = document.createElement("div");
  el.textContent = msg;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    padding: "10px 16px",
    borderRadius: "8px",
    background: isError ? "#c0392b" : "#1e1e1e",
    color: "#fff",
    font: "13px system-ui, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
