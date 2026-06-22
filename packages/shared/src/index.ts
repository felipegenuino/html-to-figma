/**
 * Schema do JSON intermediário compartilhado entre a extensão (produtor)
 * e o plugin do Figma (consumidor).
 *
 * Convenções:
 * - Todas as coordenadas são absolutas em relação à página (não ao viewport).
 * - Cores são strings rgba() já resolvidas pelo getComputedStyle.
 * - Unidades já resolvidas em px.
 */

export const SCHEMA_VERSION = 13 as const;

/** Marcador para o plugin validar que o clipboard contém uma captura nossa. */
export const CLIPBOARD_MARKER = "h2f-capture" as const;

/** Servidor relay local (WebSocket) para transferir capturas grandes sem clipboard. */
export const RELAY_PORT = 7341 as const;
export const RELAY_URL = `ws://localhost:${RELAY_PORT}` as const;

export interface CaptureDocument {
  marker: typeof CLIPBOARD_MARKER;
  version: number;
  source: {
    url: string;
    title: string;
    capturedAt: string; // ISO 8601
    viewport: { width: number; height: number };
    devicePixelRatio: number;
  };
  root: CapturedNode;
}

export type CapturedNode =
  | ElementNode
  | TextNode
  | ImageNode
  | SvgNode;

export interface Rect {
  /** Absoluto em relação à página. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BaseNode {
  /** Nome da layer no Figma (ex.: "div.card", "img#logo"). */
  name: string;
  rect: Rect;
  /**
   * true quando o pai vira Auto Layout mas este filho é position:absolute/fixed
   * — no Figma recebe layoutPositioning ABSOLUTE e mantém x/y.
   */
  absolute?: boolean;
  /**
   * Célula no grid do pai (índices 0-based), derivada da geometria renderizada.
   * Preenchido só para filhos diretos de um container grid que não sejam
   * `absolute`. Usado pelo plugin para placement explícito (spans inclusos).
   */
  gridArea?: {
    columnStart: number;
    columnSpan: number;
    rowStart: number;
    rowSpan: number;
  };
}

/** Container genérico (div, section, button...) → Frame no Figma. */
export interface ElementNode extends BaseNode {
  type: "element";
  tag: string;
  styles: ElementStyles;
  children: CapturedNode[];
}

/** Linha visual de texto → TextNode no Figma (um nó por line box). */
export interface TextNode extends BaseNode {
  type: "text";
  content: string;
  styles: TextStyles;
}

/** <img> ou background-image → Rectangle com image fill. */
export interface ImageNode extends BaseNode {
  type: "image";
  /** data URL (preferido) ou URL remota se a conversão falhar. */
  src: string;
  objectFit: "fill" | "contain" | "cover" | "none" | "scale-down";
  borderRadius: BorderRadius;
  borders: Borders | null;
  boxShadow: Shadow[];
  opacity: number;
}

/** SVG inline → importado via createNodeFromSvg. */
export interface SvgNode extends BaseNode {
  type: "svg";
  /** outerHTML do <svg>. */
  svg: string;
}

/** display:flex ou display:grid detectado → Auto Layout / Grid no Figma. */
export interface AutoLayout {
  /** "flex" → Auto Layout 1D; "grid" → Grid layout do Figma. */
  mode: "flex" | "grid";
  direction: "horizontal" | "vertical";
  /** flex-direction *-reverse: a ordem dos filhos é invertida no Figma. */
  reverse: boolean;
  gap: number;
  /** Grid: número de colunas/linhas e seus gaps (em px). */
  columns: number;
  rows: number;
  /** Grid: tamanho px de cada track (já resolvido). Vazio = tracks FLEX uniformes. */
  columnSizes: number[];
  rowSizes: number[];
  rowGap: number;
  columnGap: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  alignItems: "start" | "center" | "end" | "stretch" | "baseline";
  justifyContent: "start" | "center" | "end" | "space-between";
  wrap: boolean;
}

export interface ElementStyles {
  backgroundColor: string | null; // rgba() ou null se transparente
  /**
   * Camadas de background-image, na ordem do CSS (índice 0 = topo, na frente).
   * Vazio quando não há background-image. backgroundColor pinta atrás de tudo.
   */
  backgroundLayers: BackgroundLayer[];
  /** Bordas por lado (null quando nenhum lado tem borda visível). */
  borders: Borders | null;
  borderRadius: BorderRadius;
  boxShadow: Shadow[];
  /** filter: blur(px) → LAYER_BLUR no Figma. 0 = nenhum. */
  layerBlur: number;
  /** backdrop-filter: blur(px) → BACKGROUND_BLUR no Figma. 0 = nenhum. */
  backgroundBlur: number;
  /** mix-blend-mode (valor CSS, ex.: "multiply"); null = normal (não altera). */
  blendMode: string | null;
  opacity: number;
  overflowHidden: boolean;
  layout: AutoLayout | null;
  /**
   * Rotação em graus extraída de `transform` (sentido CSS, horário positivo).
   * Quando != 0, o `rect` representa a caixa NÃO-transformada e o nó é
   * rotacionado no Figma em torno do centro. 0 = sem rotação.
   */
  rotation: number;
}

export interface TextStyles {
  fontFamily: string; // primeira família da lista
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  lineHeight: number | null; // px, null = auto
  letterSpacing: number; // px
  color: string; // rgba()
  /** background-clip:text → gradiente aplicado como fill do texto (senão null). */
  gradient: Gradient | null;
  textAlign: "left" | "center" | "right" | "justify";
  textDecoration: "none" | "underline" | "line-through";
  textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
  /** text-shadow → DROP_SHADOW no TextNode (spread/inset sempre 0/false). */
  textShadow: Shadow[];
}

/** Uma borda de um lado. */
export interface SideBorder {
  width: number;
  color: string; // rgba()
  style: "solid" | "dashed" | "dotted";
}

/** Bordas por lado; cada lado é null quando não tem borda visível. */
export interface Borders {
  top: SideBorder | null;
  right: SideBorder | null;
  bottom: SideBorder | null;
  left: SideBorder | null;
}

export interface BorderRadius {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export interface Shadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string;
  inset: boolean;
}

/** Uma camada de background-image: imagem (data URL) ou gradiente. */
export type BackgroundLayer =
  | { kind: "image"; src: string; scaleMode: "FILL" | "FIT" }
  | { kind: "gradient"; gradient: Gradient };

export interface Gradient {
  type: "linear" | "radial" | "conic";
  /** linear: direção em graus; conic: from-angle; radial: 0 (não usado). */
  angle: number;
  /** Centro 0..1 para radial/conic; linear ignora (default 0.5/0.5). */
  center: { x: number; y: number };
  stops: { color: string; position: number }[]; // position 0..1
}

/** Parse de "rgba(r, g, b, a)" / "rgb(r, g, b)" → componentes 0..1. */
export function parseRgba(
  s: string
): { r: number; g: number; b: number; a: number } | null {
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) return null;
  return {
    r: Number(m[1]) / 255,
    g: Number(m[2]) / 255,
    b: Number(m[3]) / 255,
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

export function isCaptureDocument(v: unknown): v is CaptureDocument {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CaptureDocument).marker === CLIPBOARD_MARKER &&
    typeof (v as CaptureDocument).root === "object"
  );
}
