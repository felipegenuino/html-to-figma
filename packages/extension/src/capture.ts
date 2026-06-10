import type {
  CaptureDocument,
  CapturedNode,
  ElementNode,
  TextNode,
  ImageNode,
  SvgNode,
  ElementStyles,
  TextStyles,
  BorderRadius,
  Shadow,
  Gradient,
  Rect,
} from "@h2f/shared";
import { CLIPBOARD_MARKER, SCHEMA_VERSION } from "@h2f/shared";

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "TEMPLATE", "HEAD", "IFRAME",
]);

/** Captura a página inteira ou um elemento específico. */
export async function capture(root: Element): Promise<CaptureDocument> {
  // Normaliza o scroll: elementos fixed/sticky ficam nas coordenadas certas
  const prevX = scrollX;
  const prevY = scrollY;
  scrollTo(0, 0);
  await nextFrame();
  try {
    const node = await walkElement(root);
    return {
      marker: CLIPBOARD_MARKER,
      version: SCHEMA_VERSION,
      source: {
        url: location.href,
        title: document.title,
        capturedAt: new Date().toISOString(),
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio: devicePixelRatio,
      },
      root: node ?? emptyRoot(),
    };
  } finally {
    scrollTo(prevX, prevY);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  );
}

function emptyRoot(): ElementNode {
  return {
    type: "element",
    tag: "body",
    name: "body",
    rect: { x: 0, y: 0, width: innerWidth, height: innerHeight },
    styles: defaultStyles(),
    children: [],
  };
}

// ---------------------------------------------------------------- geometria

function pageRect(r: DOMRect): Rect {
  return {
    x: r.left + scrollX,
    y: r.top + scrollY,
    width: r.width,
    height: r.height,
  };
}

function unionRect(a: DOMRect, b: DOMRect): DOMRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.right, b.right);
  const bottom = Math.max(a.bottom, b.bottom);
  return new DOMRect(left, top, right - left, bottom - top);
}

function isInvisible(el: Element, cs: CSSStyleDeclaration, r: DOMRect): boolean {
  if (cs.display === "none" || cs.visibility === "hidden") return true;
  if (Number(cs.opacity) === 0) return true;
  if (r.width < 1 && r.height < 1) return true;
  return false;
}

// -------------------------------------------------------------- paint order

/**
 * Aproximação da ordem de pintura CSS: z-index negativo primeiro,
 * depois fluxo normal (DOM order), depois posicionados (z auto/0),
 * depois z-index positivo crescente.
 */
function paintOrderKey(cs: CSSStyleDeclaration): number {
  const positioned = cs.position !== "static";
  const z = cs.zIndex === "auto" ? null : parseInt(cs.zIndex, 10);
  if (positioned && z !== null && !isNaN(z)) return z === 0 ? 0.5 : z;
  if (positioned) return 0.5;
  return 0;
}

// ------------------------------------------------------------------- walker

async function walkElement(el: Element): Promise<CapturedNode | null> {
  if (SKIP_TAGS.has(el.tagName)) return null;

  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (isInvisible(el, cs, r)) return null;

  if (el instanceof SVGSVGElement) return svgNode(el, r);
  if (el instanceof HTMLImageElement) return await imageNode(el, cs, r);

  const entries: { key: number; idx: number; node: CapturedNode }[] = [];
  let idx = 0;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      for (const t of textNodes(child as Text, cs)) {
        entries.push({ key: 0, idx: idx++, node: t });
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;
      const node = await walkElement(childEl);
      if (node) {
        entries.push({
          key: paintOrderKey(getComputedStyle(childEl)),
          idx: idx++,
          node,
        });
      }
    }
  }
  entries.sort((a, b) => a.key - b.key || a.idx - b.idx);

  return {
    type: "element",
    tag: el.tagName.toLowerCase(),
    name: layerName(el),
    rect: pageRect(r),
    styles: await elementStyles(el, cs),
    children: entries.map((e) => e.node),
  };
}

function layerName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = typeof el.className === "string" && el.className.trim()
    ? "." + el.className.trim().split(/\s+/)[0]
    : "";
  return tag + cls;
}

// --------------------------------------------------------------------- text

/**
 * Um TextNode por linha visual (line box), com rect exato — assim a quebra
 * de linha do navegador é preservada e o Figma não re-quebra diferente.
 */
function textNodes(t: Text, parentCs: CSSStyleDeclaration): TextNode[] {
  const raw = t.textContent ?? "";
  if (!raw.trim()) return [];

  const styles = textStylesFrom(parentCs);
  const lines = splitLines(t);
  return lines.map((line) => ({
    type: "text" as const,
    name: line.content.slice(0, 40),
    rect: line.rect,
    content: line.content,
    styles,
  }));
}

/** Agrupa caracteres por linha visual usando um rect por caractere. */
function splitLines(t: Text): { content: string; rect: Rect }[] {
  const text = t.textContent ?? "";
  const range = document.createRange();
  type Line = { chars: string[]; top: number; height: number; rect: DOMRect };
  const lines: Line[] = [];
  let cur: Line | null = null;

  for (let i = 0; i < text.length; i++) {
    range.setStart(t, i);
    range.setEnd(t, i + 1);
    const cr = range.getBoundingClientRect();
    if (cr.width === 0 && cr.height === 0) {
      // whitespace colapsado — pertence à linha atual
      if (cur) cur.chars.push(text[i]);
      continue;
    }
    if (!cur || Math.abs(cr.top - cur.top) > Math.max(cur.height, cr.height) / 2) {
      cur = { chars: [text[i]], top: cr.top, height: cr.height, rect: cr };
      lines.push(cur);
    } else {
      cur.chars.push(text[i]);
      cur.rect = unionRect(cur.rect, cr);
    }
  }

  return lines
    .map((l) => ({
      content: l.chars.join("").replace(/\s+/g, " ").trim(),
      rect: pageRect(l.rect),
    }))
    .filter((l) => l.content.length > 0);
}

function textStylesFrom(cs: CSSStyleDeclaration): TextStyles {
  const lh = cs.lineHeight;
  return {
    fontFamily: cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, ""),
    fontSize: parseFloat(cs.fontSize),
    fontWeight: Number(cs.fontWeight) || 400,
    fontStyle: cs.fontStyle === "italic" ? "italic" : "normal",
    lineHeight: lh.endsWith("px") ? parseFloat(lh) : null,
    letterSpacing: cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing),
    color: cs.color,
    textAlign: (["left", "center", "right", "justify"].includes(cs.textAlign)
      ? cs.textAlign
      : "left") as TextStyles["textAlign"],
    textDecoration: cs.textDecorationLine.includes("underline")
      ? "underline"
      : cs.textDecorationLine.includes("line-through")
        ? "line-through"
        : "none",
    textTransform: (["uppercase", "lowercase", "capitalize"].includes(cs.textTransform)
      ? cs.textTransform
      : "none") as TextStyles["textTransform"],
  };
}

// ------------------------------------------------------------------ imagens

/** Formatos que figma.createImage aceita. */
const FIGMA_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const MAX_DIM = 4096; // limite do Figma

async function imageNode(
  img: HTMLImageElement,
  cs: CSSStyleDeclaration,
  r: DOMRect
): Promise<ImageNode> {
  const url = img.currentSrc || img.src;
  return {
    type: "image",
    name: layerName(img),
    rect: pageRect(r),
    src: (await toDataURL(url, r.width, r.height)) ?? url,
    objectFit: (cs.objectFit || "fill") as ImageNode["objectFit"],
    borderRadius: parseRadius(cs),
  };
}

/**
 * URL → data URL pronta para o Figma:
 * 1. Busca via service worker (bypassa CORS da página);
 * 2. fallback: fetch da própria página;
 * 3. converte formatos não suportados (webp/avif/svg) para PNG via canvas
 *    e reduz para o limite de 4096px se necessário.
 */
async function toDataURL(
  url: string,
  fallbackW = 0,
  fallbackH = 0
): Promise<string | null> {
  if (!url) return null;
  const dataUrl = url.startsWith("data:") ? url : await fetchDataUrl(url);
  if (!dataUrl) return null;
  return normalizeImage(dataUrl, fallbackW, fallbackH);
}

async function fetchDataUrl(url: string): Promise<string | null> {
  const abs = new URL(url, location.href).href;
  // 1) via background (sem CORS)
  try {
    const res = await chrome.runtime.sendMessage({ type: "h2f-fetch", url: abs });
    if (res?.ok && typeof res.dataUrl === "string") return res.dataUrl;
  } catch { /* sem extensão neste contexto — segue o fallback */ }
  // 2) fetch da página
  try {
    const blob = await (await fetch(abs, { mode: "cors" })).blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function normalizeImage(
  dataUrl: string,
  dispW: number,
  dispH: number
): Promise<string | null> {
  const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
  const img = await loadImage(dataUrl);
  if (!img) return FIGMA_TYPES.has(mime) ? dataUrl : null;

  const nw = img.naturalWidth || dispW || 512;
  const nh = img.naturalHeight || dispH || 512;
  // Alvo: tamanho exibido x DPR (com folga de 1.5x), cap em 2048 - evita JSONs gigantes
  const disp = Math.max(dispW, dispH);
  const target = Math.min(
    MAX_DIM,
    disp > 0 ? Math.max(256, Math.round(disp * (devicePixelRatio || 1) * 1.5)) : 2048,
    2048
  );
  const needResize = Math.max(nw, nh) > target;
  if (FIGMA_TYPES.has(mime) && !needResize) return dataUrl;

  const scale = Math.min(1, target / Math.max(nw, nh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(nw * scale));
  canvas.height = Math.max(1, Math.round(nh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // JPEG (menor) quando nao ha transparencia; PNG quando ha
    return hasAlpha(img)
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null; // canvas tainted ou decode falhou
  }
}

/** Amostra 32x32 para detectar canal alpha sem custo de getImageData gigante. */
function hasAlpha(img: HTMLImageElement): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 255) return true;
    }
    return false;
  } catch {
    return true; // na duvida, PNG
  }
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ---------------------------------------------------------------------- svg

function svgNode(el: SVGSVGElement, r: DOMRect): SvgNode {
  return {
    type: "svg",
    name: layerName(el),
    rect: pageRect(r),
    svg: el.outerHTML,
  };
}

// ------------------------------------------------------------------ estilos

function defaultStyles(): ElementStyles {
  return {
    backgroundColor: null,
    backgroundImage: null,
    gradient: null,
    border: null,
    borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
    boxShadow: [],
    opacity: 1,
    overflowHidden: false,
  };
}

async function elementStyles(
  el: Element,
  cs: CSSStyleDeclaration
): Promise<ElementStyles> {
  const bg = cs.backgroundColor;
  const transparent = bg === "rgba(0, 0, 0, 0)" || bg === "transparent";

  let backgroundImage: string | null = null;
  let gradient: Gradient | null = null;
  const bgi = cs.backgroundImage;
  if (bgi && bgi !== "none") {
    const urlMatch = bgi.match(/url\(["']?([^"')]+)["']?\)/);
    if (urlMatch) {
      const r = el.getBoundingClientRect();
      backgroundImage = await toDataURL(urlMatch[1], r.width, r.height);
    } else {
      gradient = parseGradient(bgi);
    }
  }

  const bw = parseFloat(cs.borderTopWidth);
  const border =
    bw > 0 && cs.borderTopStyle !== "none"
      ? {
          width: bw,
          color: cs.borderTopColor,
          style: (["dashed", "dotted"].includes(cs.borderTopStyle)
            ? cs.borderTopStyle
            : "solid") as "solid" | "dashed" | "dotted",
        }
      : null;

  return {
    backgroundColor: transparent ? null : bg,
    backgroundImage,
    gradient,
    border,
    borderRadius: parseRadius(cs),
    boxShadow: parseShadows(cs.boxShadow),
    opacity: Number(cs.opacity),
    overflowHidden: cs.overflow === "hidden" || cs.overflow === "clip",
  };
}

function parseRadius(cs: CSSStyleDeclaration): BorderRadius {
  const px = (v: string) => parseFloat(v) || 0;
  return {
    topLeft: px(cs.borderTopLeftRadius),
    topRight: px(cs.borderTopRightRadius),
    bottomRight: px(cs.borderBottomRightRadius),
    bottomLeft: px(cs.borderBottomLeftRadius),
  };
}

/** Divide uma lista CSS por vírgulas que estão fora de parênteses. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseShadows(v: string): Shadow[] {
  if (!v || v === "none") return [];
  return splitTopLevel(v).flatMap((part) => {
    const inset = part.includes("inset");
    const color = part.match(/rgba?\([^)]+\)/)?.[0] ?? "rgba(0,0,0,0.25)";
    const nums = part
      .replace(/rgba?\([^)]+\)/, "")
      .replace("inset", "")
      .trim()
      .split(/\s+/)
      .map(parseFloat);
    if (nums.length < 2 || nums.some(isNaN)) return [];
    const [offsetX, offsetY, blur = 0, spread = 0] = nums;
    return [{ offsetX, offsetY, blur, spread, color, inset }];
  });
}

/** Parser básico de linear-gradient (cobre os casos comuns do computed style). */
function parseGradient(v: string): Gradient | null {
  const m = v.match(/linear-gradient\((.+)\)$/);
  if (!m) return null;
  const parts = splitTopLevel(m[1]);
  let angle = 180;
  if (parts[0]?.endsWith("deg")) angle = parseFloat(parts.shift()!);
  else if (parts[0]?.startsWith("to ")) {
    const dir = parts.shift()!;
    angle = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 }[dir] ?? 180;
  }
  const stops = parts.flatMap((p, i) => {
    const color = p.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/)?.[0];
    if (!color) return [];
    const pos = p.match(/([\d.]+)%/);
    return [{ color, position: pos ? Number(pos[1]) / 100 : i / Math.max(parts.length - 1, 1) }];
  });
  return stops.length >= 2 ? { type: "linear", angle, stops } : null;
}
