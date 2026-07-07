import type {
  CapturedNode,
  ElementNode,
  TextNode as H2FTextNode,
  ImageNode,
  SvgNode,
  Rect,
  Gradient,
  Borders,
  SideBorder,
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
    const baseName = doc.source.title || doc.source.url;
    const frame = await buildRoot(doc.root, baseName);
    figma.currentPage.appendChild(frame);
    const made: FrameNode[] = [frame];

    // Estados "click" (menu/modal/drawer) como frames separados, à direita.
    const overlays: CapturedNode[] = doc.overlays ?? [];
    let nextX = frame.x + frame.width + 80;
    for (let i = 0; i < overlays.length; i++) {
      const ov = await buildRoot(overlays[i], `▸ overlay ${i + 1} · ${baseName}`);
      figma.currentPage.appendChild(ov);
      ov.x = nextX;
      ov.y = frame.y;
      nextX += ov.width + 80;
      made.push(ov);
    }

    figma.viewport.scrollAndZoomIntoView(made);
    figma.currentPage.selection = made;
    const extra = overlays.length ? ` (+${overlays.length} overlay)` : "";
    figma.ui.postMessage({ text: `✓ Importado!${extra}` });
    figma.notify(`Página importada${extra}`);
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

  // backgroundColor pinta atrás de tudo (primeiro no array = fundo no Figma).
  if (s.backgroundColor) {
    const c = parseRgba(s.backgroundColor);
    if (c) fills.push({ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a });
  }
  // Camadas: CSS lista o topo primeiro; no Figma o último fill fica no topo,
  // então empilhamos em ordem reversa.
  for (let i = s.backgroundLayers.length - 1; i >= 0; i--) {
    const layer = s.backgroundLayers[i];
    if (layer.kind === "gradient") {
      const g = gradientPaint(layer.gradient);
      if (g) fills.push(g);
    } else if (layer.src.startsWith("data:")) {
      const img = imageFromDataUrl(layer.src);
      if (img) fills.push({ type: "IMAGE", imageHash: img.hash, scaleMode: layer.scaleMode });
    }
  }
  f.fills = fills;

  const borderOverlays = applyBorders(f, s.borders);

  f.topLeftRadius = s.borderRadius.topLeft;
  f.topRightRadius = s.borderRadius.topRight;
  f.bottomRightRadius = s.borderRadius.bottomRight;
  f.bottomLeftRadius = s.borderRadius.bottomLeft;

  const shadowEffects = s.boxShadow.flatMap((sh): Effect[] => {
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
  // O radius de blur do Figma é ~2× o valor px do CSS (radius ≈ 2× stdDeviation
  // gaussiano); sem o fator o blur sai pela metade.
  const blurEffects: Effect[] = [];
  if (s.layerBlur > 0)
    blurEffects.push({ type: "LAYER_BLUR", radius: s.layerBlur * 2, visible: true, blurType: "NORMAL" });
  if (s.backgroundBlur > 0)
    blurEffects.push({ type: "BACKGROUND_BLUR", radius: s.backgroundBlur * 2, visible: true, blurType: "NORMAL" });
  f.effects = [...shadowEffects, ...blurEffects];

  f.opacity = s.opacity;
  const blend = cssToBlendMode(s.blendMode);
  if (blend) f.blendMode = blend;
  f.clipsContent = s.overflowHidden;

  if (s.layout) applyLayout(f, s.layout, n.rect);

  // flex *-reverse: o Figma não tem "reverse" — invertemos a ordem dos filhos.
  const children =
    s.layout && s.layout.mode === "flex" && s.layout.reverse
      ? [...n.children].reverse()
      : n.children;

  const gridChildren: { node: SceneNode; area: NonNullable<CapturedNode["gridArea"]> }[] = [];
  for (const child of children) {
    const c = await buildNode(child, { x: n.rect.x, y: n.rect.y });
    if (c) {
      f.appendChild(c);
      // filhos position:absolute/fixed mantem coordenadas dentro do Auto Layout
      if (s.layout && child.absolute && "layoutPositioning" in c) {
        c.layoutPositioning = "ABSOLUTE";
        place(c, child.rect, { x: n.rect.x, y: n.rect.y });
      } else if (child.gridArea) {
        gridChildren.push({ node: c, area: child.gridArea });
      }
    }
  }

  // Grid: aplica posicionamento explícito quando o grid de fato usa placement
  // não-trivial (spans ou ordem não-sequencial); senão mantém o auto-flow.
  if (s.layout && s.layout.mode === "grid") {
    applyGridPlacement(f, s.layout.columns, gridChildren);
  }

  // Bordas multicolor: retângulos por lado, no topo da ordem de pintura.
  for (const rect of borderOverlays) {
    f.appendChild(rect);
    if (s.layout) rect.layoutPositioning = "ABSOLUTE";
  }

  // transform: rotação (depois dos filhos, já que rotaciona o frame inteiro).
  if (s.rotation) applyRotation(f, n.rect, offset, s.rotation);
  return f;
}

/**
 * Aplica rotação CSS (horária) ao nó. O Figma rotaciona no sentido anti-horário
 * em torno do canto superior-esquerdo, então invertemos o ângulo e reposicionamos
 * o canto para manter o centro da caixa fixo no ponto capturado.
 */
function applyRotation(
  node: SceneNode,
  rect: Rect,
  offset: { x: number; y: number },
  cssDegrees: number
) {
  const theta = (-cssDegrees * Math.PI) / 180; // Figma: anti-horário positivo
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Centro desejado em coordenadas locais ao pai.
  const cx = rect.x - offset.x + rect.width / 2;
  const cy = rect.y - offset.y + rect.height / 2;
  // Vetor centro→ canto antes da rotação e sua imagem rotacionada (matriz do Figma).
  const vx = rect.width / 2;
  const vy = rect.height / 2;
  const rvx = cos * vx + sin * vy;
  const rvy = -sin * vx + cos * vy;
  if (!("rotation" in node)) return;
  node.x = cx - rvx;
  node.y = cy - rvy;
  node.rotation = -cssDegrees;
}

/** Configura Auto Layout (flex) ou Grid no frame, preservando o tamanho capturado. */
/** Fixa o tamanho px de cada track capturada (deixa as demais em FLEX). */
function applyTrackSizes(tracks: GridTrackSize[], sizes: number[]) {
  for (let i = 0; i < sizes.length && i < tracks.length; i++) {
    if (sizes[i] > 0) {
      tracks[i].type = "FIXED";
      tracks[i].value = sizes[i];
    }
  }
}

type GridChild = { node: SceneNode; area: NonNullable<CapturedNode["gridArea"]> };

interface GridPositionable {
  gridColumnSpan: number;
  gridRowSpan: number;
  setGridChildPosition(rowIndex: number, columnIndex: number): void;
}

/**
 * Posiciona filhos no grid. Se todos forem 1×1 na ordem row-major natural, é um
 * auto-flow comum e nada muda (preserva o comportamento atual). Caso contrário,
 * ativa MANUAL e fixa a célula (start + span) de cada filho.
 */
function applyGridPlacement(f: FrameNode, columns: number, children: GridChild[]): void {
  if (children.length === 0) return;
  const cols = Math.max(columns, 1);
  const trivial = children.every(
    (c, k) =>
      c.area.columnSpan === 1 &&
      c.area.rowSpan === 1 &&
      c.area.columnStart === k % cols &&
      c.area.rowStart === Math.floor(k / cols)
  );
  if (trivial) return;

  // O placement vem da geometria; se duas células coincidem (ex.: rowSizes
  // incompleto em grids de linhas auto, jogando vários itens em row 0), o Figma
  // não consegue posicionar (uma célula = um nó). Mapeamento ambíguo → cai pro
  // auto-flow em vez de crashar.
  const cells = new Set(children.map((c) => `${c.area.rowStart},${c.area.columnStart}`));
  if (cells.size < children.length) return;

  let maxCol = 0;
  let maxRow = 0;
  for (const { area } of children) {
    maxCol = Math.max(maxCol, area.columnStart + area.columnSpan);
    maxRow = Math.max(maxRow, area.rowStart + area.rowSpan);
  }
  f.gridItemsPositioning = "MANUAL";

  // O Figma rejeita posicionar/expandir um filho sobre células ocupadas, e mover
  // um-a-um tem ciclos de colisão (A quer a célula de B e vice-versa). Quebramos
  // os ciclos estacionando todos numa linha de rascunho vazia (grade expandida),
  // depois movemos cada um para a célula final (área real já vazia) e por fim
  // crescemos os spans; no fim removemos o espaço de rascunho.
  // Contagens reais da grade (preserva colunas/linhas vazias além do maior span).
  const baseCols = Math.max(f.gridColumnCount, maxCol);
  const baseRows = Math.max(f.gridRowCount, maxRow);

  const placeable = children.filter((c) => "setGridChildPosition" in c.node);
  const parkRow = baseRows; // linha nova, além das reais
  f.gridColumnCount = Math.max(baseCols, placeable.length, 1);
  f.gridRowCount = baseRows + 1;

  try {
    placeable.forEach(({ node }, i) => {
      const gc = node as unknown as GridPositionable;
      gc.gridColumnSpan = 1;
      gc.gridRowSpan = 1;
      gc.setGridChildPosition(parkRow, i);
    });
    for (const { node, area } of placeable) {
      (node as unknown as GridPositionable).setGridChildPosition(area.rowStart, area.columnStart);
    }
    for (const { node, area } of placeable) {
      const gc = node as unknown as GridPositionable;
      gc.gridColumnSpan = area.columnSpan;
      gc.gridRowSpan = area.rowSpan;
    }
    f.gridColumnCount = baseCols;
    f.gridRowCount = baseRows;
  } catch (e) {
    // Colisão imprevista (ex.: spans sobrepostos) — degrada pro auto-flow do
    // Figma em vez de abortar o import inteiro.
    f.gridColumnCount = baseCols;
    f.gridRowCount = baseRows;
    f.gridItemsPositioning = "ROW_AUTO_FLOW";
  }
}

function applyLayout(f: FrameNode, L: NonNullable<ElementNode["styles"]["layout"]>, rect: Rect) {
  f.paddingTop = L.paddingTop;
  f.paddingRight = L.paddingRight;
  f.paddingBottom = L.paddingBottom;
  f.paddingLeft = L.paddingLeft;

  if (L.mode === "grid") {
    f.layoutMode = "GRID";
    f.gridColumnCount = Math.max(L.columns, 1);
    f.gridRowCount = Math.max(L.rows, 1);
    f.gridColumnGap = L.columnGap;
    f.gridRowGap = L.rowGap;
    // Tracks não-uniformes: fixa o tamanho px de cada track capturada.
    // Tracks sem tamanho permanecem FLEX (default).
    applyTrackSizes(f.gridColumnSizes, L.columnSizes);
    applyTrackSizes(f.gridRowSizes, L.rowSizes);
    f.resize(Math.max(rect.width, 0.01), Math.max(rect.height, 0.01));
    return;
  }

  f.layoutMode = L.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  f.primaryAxisSizingMode = "FIXED";
  f.counterAxisSizingMode = "FIXED";
  f.itemSpacing = L.gap;
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
  f.resize(Math.max(rect.width, 0.01), Math.max(rect.height, 0.01));
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

  // background-clip:text → fill de gradiente; senão cor sólida.
  const gp = s.gradient ? gradientPaint(s.gradient) : null;
  if (gp) {
    t.fills = [gp];
  } else {
    const c = parseRgba(s.color);
    if (c) t.fills = [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
  }

  t.effects = s.textShadow.flatMap((sh): Effect[] => {
    const sc = parseRgba(sh.color);
    if (!sc) return [];
    return [{
      type: "DROP_SHADOW",
      color: { r: sc.r, g: sc.g, b: sc.b, a: sc.a },
      offset: { x: sh.offsetX, y: sh.offsetY },
      radius: sh.blur,
      spread: 0,
      visible: true,
      blendMode: "NORMAL",
    }];
  });

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

  applyImageBorders(r, n.borders);
  r.effects = n.boxShadow.flatMap((sh): Effect[] => {
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
  r.opacity = n.opacity;
  return r;
}

/** Borda nativa para imagens (RectangleNode): larguras por lado + 1 cor. */
function applyImageBorders(r: RectangleNode, borders: Borders | null): void {
  if (!borders) return;
  const visible = SIDES.map((side) => borders[side]).filter((b): b is SideBorder => b !== null);
  if (visible.length === 0) return;
  const c = parseRgba(visible[0].color);
  if (!c) return;
  r.strokes = [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
  r.strokeAlign = "INSIDE";
  r.strokeTopWeight = borders.top?.width ?? 0;
  r.strokeRightWeight = borders.right?.width ?? 0;
  r.strokeBottomWeight = borders.bottom?.width ?? 0;
  r.strokeLeftWeight = borders.left?.width ?? 0;
  const st = visible[0].style;
  if (st === "dashed") r.dashPattern = [visible[0].width * 3, visible[0].width * 2];
  if (st === "dotted") r.dashPattern = [visible[0].width, visible[0].width];
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

// -------------------------------------------------------------- blend mode

const BLEND_MODES = new Set<BlendMode>([
  "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN",
  "SCREEN", "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT",
  "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
]);

/** mix-blend-mode CSS → BlendMode do Figma (ex.: "color-dodge" → COLOR_DODGE). */
function cssToBlendMode(css: string | null): BlendMode | null {
  if (!css) return null;
  const m = css.toUpperCase().replace(/-/g, "_") as BlendMode;
  return BLEND_MODES.has(m) ? m : null;
}

// ------------------------------------------------------------------ bordas

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * Aplica bordas por lado. Se todos os lados visíveis têm a mesma cor+estilo,
 * usa larguras nativas por lado (barato). Se divergem, devolve retângulos por
 * lado para o chamador anexar no topo (a cor por lado só existe assim no Figma).
 */
function applyBorders(f: FrameNode, borders: Borders | null): RectangleNode[] {
  if (!borders) return [];
  const visible = SIDES.map((side) => ({ side, b: borders[side] })).filter(
    (s): s is { side: (typeof SIDES)[number]; b: SideBorder } => s.b !== null
  );
  if (visible.length === 0) return [];

  const uniform = visible.every(
    (s) => s.b.color === visible[0].b.color && s.b.style === visible[0].b.style
  );

  if (uniform) {
    const b = visible[0].b;
    const c = parseRgba(b.color);
    if (!c) return [];
    f.strokes = [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
    f.strokeAlign = "INSIDE";
    f.strokeTopWeight = borders.top?.width ?? 0;
    f.strokeRightWeight = borders.right?.width ?? 0;
    f.strokeBottomWeight = borders.bottom?.width ?? 0;
    f.strokeLeftWeight = borders.left?.width ?? 0;
    if (b.style === "dashed") f.dashPattern = [b.width * 3, b.width * 2];
    if (b.style === "dotted") f.dashPattern = [b.width, b.width];
    return [];
  }

  // Cores/estilos divergentes → um retângulo por lado.
  const w = f.width;
  const h = f.height;
  const overlays: RectangleNode[] = [];
  for (const { side, b } of visible) {
    const c = parseRgba(b.color);
    if (!c) continue;
    const r = figma.createRectangle();
    const geom =
      side === "top"
        ? { x: 0, y: 0, w, h: b.width }
        : side === "bottom"
        ? { x: 0, y: h - b.width, w, h: b.width }
        : side === "left"
        ? { x: 0, y: 0, w: b.width, h }
        : { x: w - b.width, y: 0, w: b.width, h };
    r.resize(Math.max(geom.w, 0.01), Math.max(geom.h, 0.01));
    r.x = geom.x;
    r.y = geom.y;
    r.fills = [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
    r.name = `border-${side}`;
    overlays.push(r);
  }
  return overlays;
}

// ----------------------------------------------------------------- gradient

/** Converte um Gradient (linear/radial/conic) no GradientPaint do Figma. */
function gradientPaint(g: Gradient): GradientPaint | null {
  const stops: ColorStop[] = [];
  for (const s of g.stops) {
    const c = parseRgba(s.color) ?? hexToRgba(s.color);
    if (c) stops.push({ position: s.position, color: { r: c.r, g: c.g, b: c.b, a: c.a } });
  }
  if (stops.length < 2) return null;

  const cx = g.center.x;
  const cy = g.center.y;

  if (g.type === "radial") {
    // A gradientTransform do Figma mapeia geometria [0,1]² → espaço canônico
    // (centro 0.5/0.5, raio 0.5). Logo o centro geométrico é M⁻¹·(0.5,0.5).
    // Escolhemos a escala s para a cor final atingir o canto mais distante
    // (default "farthest-corner" do CSS): s = 0.5 / dist(centro, canto distante).
    const d = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(1 - cx, cy),
      Math.hypot(cx, 1 - cy),
      Math.hypot(1 - cx, 1 - cy)
    );
    const s = d > 0 ? 0.5 / d : 0.5;
    const gradientTransform: Transform = [
      [s, 0, 0.5 - s * cx],
      [0, s, 0.5 - s * cy],
    ];
    return { type: "GRADIENT_RADIAL", gradientTransform, gradientStops: stops };
  }

  if (g.type === "conic") {
    // GRADIENT_ANGULAR: rotação a partir do from-angle do CSS, centro em (cx,cy).
    const rad = (g.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const gradientTransform: Transform = [
      [cos, -sin, cx - 0.5 * cos + 0.5 * sin],
      [sin, cos, cy - 0.5 * sin - 0.5 * cos],
    ];
    return { type: "GRADIENT_ANGULAR", gradientTransform, gradientStops: stops };
  }

  // linear — Figma: transform identidade = gradiente da esquerda para a direita.
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
