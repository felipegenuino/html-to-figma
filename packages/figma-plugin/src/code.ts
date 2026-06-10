import type {
  CapturedNode,
  ElementNode,
  TextNode as H2FTextNode,
  ImageNode,
  SvgNode,
  Rect,
  Gradient,
} from "@h2f/shared";
import { isCaptureDocument, parseRgba } from "@h2f/shared";

figma.showUI(__html__, { width: 320, height: 380, themeColors: true });

figma.ui.onmessage = async (msg: { type: string; json?: string }) => {
  if (msg.type !== "import" || !msg.json) return;
  try {
    const doc = JSON.parse(msg.json);
    if (!isCaptureDocument(doc)) {
      throw new Error("JSON inválido — capture novamente com a extensão.");
    }
    const frame = await buildRoot(doc.root, doc.source.title || doc.source.url);
    figma.currentPage.appendChild(frame);
    figma.viewport.scrollAndZoomIntoView([frame]);
    figma.currentPage.selection = [frame];
    figma.ui.postMessage({ text: "✓ Importado!" });
    figma.notify("Página importada");
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    figma.ui.postMessage({ text, error: true });
  }
};

// --------------------------------------------------------------------- raiz

async function buildRoot(root: CapturedNode, name: string): Promise<FrameNode> {
  const node = await buildNode(root, { x: root.rect.x, y: root.rect.y });
  if (node && node.type === "FRAME") {
    node.name = name.slice(0, 80);
    node.x = figma.viewport.center.x - root.rect.width / 2;
    node.y = figma.viewport.center.y - root.rect.height / 2;
    return node;
  }
  const wrapper = figma.createFrame();
  wrapper.name = name.slice(0, 80);
  wrapper.resize(Math.max(root.rect.width, 1), Math.max(root.rect.height, 1));
  if (node) wrapper.appendChild(node);
  return wrapper;
}

/** offset = origem do pai em coordenadas de página. */
async function buildNode(
  n: CapturedNode,
  offset: { x: number; y: number }
): Promise<SceneNode | null> {
  switch (n.type) {
    case "element": return buildElement(n, offset);
    case "text":    return buildText(n, offset);
    case "image":   return buildImage(n, offset);
    case "svg":     return buildSvg(n, offset);
  }
}

function place(node: SceneNode, rect: Rect, offset: { x: number; y: number }) {
  node.x = rect.x - offset.x;
  node.y = rect.y - offset.y;
}

// ------------------------------------------------------------------ element

async function buildElement(
  n: ElementNode,
  offset: { x: number; y: number }
): Promise<FrameNode> {
  const f = figma.createFrame();
  f.name = n.name;
  f.resize(Math.max(n.rect.width, 0.01), Math.max(n.rect.height, 0.01));
  place(f, n.rect, offset);

  const s = n.styles;
  const fills: Paint[] = [];

  if (s.backgroundColor) {
    const c = parseRgba(s.backgroundColor);
    if (c) fills.push({ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a });
  }
  if (s.gradient) {
    const g = gradientPaint(s.gradient);
    if (g) fills.push(g);
  }
  if (s.backgroundImage && s.backgroundImage.startsWith("data:")) {
    const img = imageFromDataUrl(s.backgroundImage);
    if (img) fills.push({ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" });
  }
  f.fills = fills;

  if (s.border) {
    const c = parseRgba(s.border.color);
    if (c) {
      f.strokes = [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
      f.strokeWeight = s.border.width;
      f.strokeAlign = "INSIDE";
      if (s.border.style === "dashed") f.dashPattern = [s.border.width * 3, s.border.width * 2];
      if (s.border.style === "dotted") f.dashPattern = [s.border.width, s.border.width];
    }
  }

  f.topLeftRadius = s.borderRadius.topLeft;
  f.topRightRadius = s.borderRadius.topRight;
  f.bottomRightRadius = s.borderRadius.bottomRight;
  f.bottomLeftRadius = s.borderRadius.bottomLeft;

  f.effects = s.boxShadow.flatMap((sh): Effect[] => {
    const c = parseRgba(sh.color);
    if (!c) return [];
    return [{
      type: sh.inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r: c.r, g: c.g, b: c.b, a: c.a },
      offset: { x: sh.offsetX, y: sh.offsetY },
      radius: sh.blur,
      spread: sh.spread,
      visible: true,
      blendMode: "NORMAL",
    }];
  });

  f.opacity = s.opacity;
  f.clipsContent = s.overflowHidden;

  if (s.layout) {
    const L = s.layout;
    f.layoutMode = L.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    f.primaryAxisSizingMode = "FIXED";
    f.counterAxisSizingMode = "FIXED";
    f.itemSpacing = L.gap;
    f.paddingTop = L.paddingTop;
    f.paddingRight = L.paddingRight;
    f.paddingBottom = L.paddingBottom;
    f.paddingLeft = L.paddingLeft;
    f.primaryAxisAlignItems = ({
      start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN",
    } as const)[L.justifyContent];
    const counter = ({
      start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE", stretch: "MIN",
    } as const)[L.alignItems];
    // BASELINE so vale para HORIZONTAL
    f.counterAxisAlignItems = counter === "BASELINE" && f.layoutMode === "VERTICAL" ? "MIN" : counter;
    if (L.wrap && f.layoutMode === "HORIZONTAL") {
      f.layoutWrap = "WRAP";
      f.counterAxisSpacing = L.gap;
    }
    // garante o tamanho capturado depois de ligar o layout
    f.resize(Math.max(n.rect.width, 0.01), Math.max(n.rect.height, 0.01));
  }

  for (const child of n.children) {
    const c = await buildNode(child, { x: n.rect.x, y: n.rect.y });
    if (c) {
      f.appendChild(c);
      // filhos position:absolute/fixed mantem coordenadas dentro do Auto Layout
      if (s.layout && child.absolute && "layoutPositioning" in c) {
        c.layoutPositioning = "ABSOLUTE";
        place(c, child.rect, { x: n.rect.x, y: n.rect.y });
      }
    }
  }
  return f;
}

// --------------------------------------------------------------------- text

const WEIGHT_STYLES: Record<number, string> = {
  100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular",
  500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black",
};

const loadedFonts = new Map<string, FontName>();

async function loadFont(family: string, weight: number, italic: boolean): Promise<FontName> {
  const key = `${family}|${weight}|${italic}`;
  const cached = loadedFonts.get(key);
  if (cached) return cached;

  const base = WEIGHT_STYLES[weight] ?? "Regular";
  const candidates: FontName[] = [
    { family, style: italic ? (base === "Regular" ? "Italic" : `${base} Italic`) : base },
    { family, style: base },
    { family, style: "Regular" },
    { family: "Inter", style: weight >= 600 ? "Bold" : "Regular" },
    { family: "Inter", style: "Regular" },
  ];
  for (const font of candidates) {
    try {
      await figma.loadFontAsync(font);
      loadedFonts.set(key, font);
      return font;
    } catch (e) { /* tenta o próximo */ }
  }
  throw new Error(`Nenhuma fonte disponível para ${family}`);
}

async function buildText(
  n: H2FTextNode,
  offset: { x: number; y: number }
): Promise<TextNode> {
  const t = figma.createText();
  const s = n.styles;
  t.fontName = await loadFont(s.fontFamily, s.fontWeight, s.fontStyle === "italic");
  t.characters = n.content;
  t.fontSize = s.fontSize;

  const c = parseRgba(s.color);
  if (c) t.fills = [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];

  if (s.lineHeight) t.lineHeight = { value: s.lineHeight, unit: "PIXELS" };
  t.letterSpacing = { value: s.letterSpacing, unit: "PIXELS" };
  t.textAlignHorizontal = (
    { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" } as const
  )[s.textAlign];
  if (s.textDecoration === "underline") t.textDecoration = "UNDERLINE";
  if (s.textDecoration === "line-through") t.textDecoration = "STRIKETHROUGH";
  if (s.textTransform === "uppercase") t.textCase = "UPPER";
  if (s.textTransform === "lowercase") t.textCase = "LOWER";
  if (s.textTransform === "capitalize") t.textCase = "TITLE";

  t.name = n.name;
  // Cada TextNode é uma linha visual — sem wrap, posição exata
  t.textAutoResize = "WIDTH_AND_HEIGHT";
  place(t, n.rect, offset);
  return t;
}

// -------------------------------------------------------------------- image

function buildImage(n: ImageNode, offset: { x: number; y: number }): RectangleNode {
  const r = figma.createRectangle();
  r.name = n.name;
  r.resize(Math.max(n.rect.width, 1), Math.max(n.rect.height, 1));
  place(r, n.rect, offset);

  r.topLeftRadius = n.borderRadius.topLeft;
  r.topRightRadius = n.borderRadius.topRight;
  r.bottomRightRadius = n.borderRadius.bottomRight;
  r.bottomLeftRadius = n.borderRadius.bottomLeft;

  const img = n.src.startsWith("data:") ? imageFromDataUrl(n.src) : null;
  if (img) {
    const scaleMode = n.objectFit === "contain" ? "FIT" : "FILL";
    r.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode }];
  } else {
    // CORS bloqueou a conversão — placeholder cinza
    r.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }];
    r.name = `${n.name} (imagem não capturada)`;
  }
  return r;
}

function imageFromDataUrl(dataUrl: string): Image | null {
  try {
    const base64 = dataUrl.split(",")[1];
    if (!base64) return null;
    return figma.createImage(base64Decode(base64));
  } catch (e) {
    return null;
  }
}

/** O sandbox do Figma não tem atob — decoder manual. */
function base64Decode(s: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = s.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = chars.indexOf(ch);
    if (v === -1) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------- svg

function buildSvg(n: SvgNode, offset: { x: number; y: number }): SceneNode {
  try {
    const node = figma.createNodeFromSvg(n.svg);
    node.name = n.name;
    node.resize(Math.max(n.rect.width, 1), Math.max(n.rect.height, 1));
    place(node, n.rect, offset);
    return node;
  } catch (e) {
    const r = figma.createRectangle();
    r.name = `${n.name} (svg inválido)`;
    r.resize(Math.max(n.rect.width, 1), Math.max(n.rect.height, 1));
    place(r, n.rect, offset);
    r.fills = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 } }];
    return r;
  }
}

// ----------------------------------------------------------------- gradient

/** Converte ângulo CSS (0° = para cima, 90° = para a direita) em gradientTransform. */
function gradientPaint(g: Gradient): GradientPaint | null {
  const stops: ColorStop[] = [];
  for (const s of g.stops) {
    const c = parseRgba(s.color) ?? hexToRgba(s.color);
    if (c) stops.push({ position: s.position, color: { r: c.r, g: c.g, b: c.b, a: c.a } });
  }
  if (stops.length < 2) return null;

  // Figma: transform identidade = gradiente da esquerda para a direita.
  // CSS 90deg = esquerda→direita, então rotacionamos (angle - 90).
  const rad = ((g.angle - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const gradientTransform: Transform = [
    [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
    [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
  ];

  return { type: "GRADIENT_LINEAR", gradientTransform, gradientStops: stops };
}

function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } | null {
  const m = hex.match(/^#([0-9a-fA-F]{3,8})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (h.length === 6) {
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  if (h.length === 8) {
    return {
      r: ((n >>> 24) & 255) / 255,
      g: ((n >> 16) & 255) / 255,
      b: ((n >> 8) & 255) / 255,
      a: (n & 255) / 255,
    };
  }
  return null;
}
