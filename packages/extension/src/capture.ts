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
  Borders,
  SideBorder,
  Shadow,
  Gradient,
  BackgroundLayer,
  Rect,
  AutoLayout,
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
  // Pipeline:
  // 0) freeze de transitions/animations (animações de entrada saltam ao final);
  // 1) rola até o footer (lazy-load, IntersectionObservers, mounts);
  // 2) detecta overlays interativos (menu/modal) para virarem estados "click";
  // 3) volta ao topo e ASSENTA (parallax JS do hero estabiliza — o topo fica em
  //    vista, então não desmonta); revela o escondido;
  // 4) walkElement faz SCROLL-FOLLOWING: rola cada elemento off-screen à viewport
  //    antes de medir, re-montando conteúdo virtualizado e lendo a geometria
  //    no lugar certo. Resolve parallax (hero lido assentado no topo) e
  //    virtualização (conteúdo re-montado ao ser alcançado) de uma vez.
  const restoreFreeze = freezeAnimations();
  await preloadLazyContent();
  const overlayRoots = findOverlayRoots();
  overlayRoots.forEach((o) => skipInWalk.add(o));
  scrollTo(0, 0);
  await nextFrame();
  await sleep(350); // parallax/JS do hero assenta (topo em vista, sem desmonte)
  await nextFrame();
  forceRevealHidden(overlayRoots);
  try {
    const node = await walkElement(root);

    // Estado "click": cada overlay revelado e capturado como nó separado.
    scrollTo(0, 0); // o scroll-following pode ter descido a página
    const overlays: CapturedNode[] = [];
    for (const ov of overlayRoots) {
      skipInWalk.delete(ov);
      const undo = forceOverlayVisible(ov);
      await nextFrame();
      const onode = await walkElement(ov);
      undo();
      skipInWalk.add(ov);
      // Só inclui overlays com conteúdo real (evita modais/lightboxes vazios).
      if (onode && hasVisibleContent(onode)) overlays.push(onode);
    }

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
      overlays,
    };
  } finally {
    restoreReveals();
    restoreFreeze();
    fixedScrollSuppressed = 0;
    skipInWalk.clear();
    scrollTo(prevX, prevY);
  }
}

/**
 * Neutraliza animações de scroll-reveal: muitos sites escondem conteúdo com
 * `opacity:0`/`visibility:hidden`/`content-visibility:auto` até o elemento entrar
 * na viewport. Como capturamos num único snapshot, força esses estados
 * TOTALMENTE escondidos a visíveis — sem tocar opacity parcial (ex.: 0.8) nem
 * `transform` (preserva rotação). Devolve uma função que restaura o original.
 */
/**
 * Congela transitions/animations: injeta um stylesheet que zera transitions e
 * deixa animations quase instantâneas, para que animações de entrada
 * (translate/scale ao revelar) saltem ao estado final em vez de serem
 * capturadas no meio. Devolve uma função que remove o stylesheet.
 */
function freezeAnimations(): () => void {
  const style = document.createElement("style");
  style.setAttribute("data-h2f-freeze", "");
  style.textContent =
    "*,*::before,*::after{transition:none!important;" +
    "animation-duration:1ms!important;animation-delay:0s!important;}";
  (document.head || document.documentElement).appendChild(style);
  return () => style.remove();
}

/** Aplica `prop:val !important` inline guardando como desfazer. */
function forceStyle(el: HTMLElement, prop: string, val: string, undo: (() => void)[]) {
  const prev = el.style.getPropertyValue(prop);
  const prevPriority = el.style.getPropertyPriority(prop);
  el.style.setProperty(prop, val, "important");
  undo.push(() =>
    prev ? el.style.setProperty(prop, prev, prevPriority) : el.style.removeProperty(prop)
  );
}

/** Desfazeres de reveal acumulados durante a captura (restaurados no finally). */
let revealUndos: (() => void)[] = [];

function revealIfHidden(el: HTMLElement) {
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
  const cs = getComputedStyle(el);
  if (parseFloat(cs.opacity) === 0) forceStyle(el, "opacity", "1", revealUndos);
  if (cs.visibility === "hidden") forceStyle(el, "visibility", "visible", revealUndos);
  if (cs.getPropertyValue("content-visibility") === "auto")
    forceStyle(el, "content-visibility", "visible", revealUndos);
}

function forceRevealHidden(exclude: Element[] = []): void {
  const isExcluded = (el: Element) => exclude.some((o) => o === el || o.contains(el));
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    if (isExcluded(el)) continue; // overlays interativos ficam para o estado "click"
    revealIfHidden(el);
  }
}

/** Revela a subárvore de um elemento (usado após montar conteúdo virtualizado). */
function forceRevealSubtree(root: HTMLElement) {
  revealIfHidden(root);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) revealIfHidden(el);
}

function restoreReveals() {
  for (const f of revealUndos) f();
  revealUndos = [];
}

/**
 * Scroll-following: traz um elemento off-screen para a viewport, montando
 * conteúdo virtualizado (que desmonta fora da tela), e revela o que nasceu
 * escondido. Só age se o elemento está fora da viewport.
 */
async function scrollIntoViewIfNeeded(el: Element): Promise<void> {
  const r = el.getBoundingClientRect();
  const offscreen = r.top >= innerHeight || r.bottom <= 0;
  if (!offscreen) return;
  el.scrollIntoView({ block: "center", inline: "nearest" });
  await nextFrame();
  await sleep(60); // IntersectionObservers/mount + lazy assets
  await nextFrame();
  forceRevealSubtree(el as HTMLElement);
}

/**
 * true se a subárvore tem conteúdo "de verdade": texto não-vazio ou imagem
 * raster. SVG sozinho NÃO conta (são quase sempre ícones/setas decorativas —
 * ex.: lightbox fechado só com setas ‹ ›, que não vale virar frame).
 */
function hasVisibleContent(n: CapturedNode): boolean {
  if (n.type === "text") return n.content.trim().length > 0;
  if (n.type === "image") return true;
  if (n.type === "svg") return false;
  return n.children.some(hasVisibleContent);
}

/**
 * Detecta overlays interativos escondidos (menu/modal/drawer): elementos
 * ocultos que são `fixed`/`absolute` cobrindo área grande, ou casam seletores
 * típicos. Retorna só os de topo (não aninhados em outro overlay).
 */
function findOverlayRoots(): HTMLElement[] {
  const SELECTOR =
    '[role="dialog"],[aria-modal="true"],[class*="overlay" i],[class*="modal" i],[class*="drawer" i],[class*="menu" i]';
  const candidates: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const hidden =
      parseFloat(cs.opacity) === 0 || cs.visibility === "hidden" || cs.display === "none";
    if (!hidden) continue;
    const r = el.getBoundingClientRect();
    const bigCover =
      (cs.position === "fixed" || cs.position === "absolute") &&
      r.width >= innerWidth * 0.5 &&
      r.height >= innerHeight * 0.5;
    let matchesSel = false;
    try {
      matchesSel = el.matches(SELECTOR);
    } catch {
      /* seletor 'i' não suportado — ignora */
    }
    if (bigCover || matchesSel) candidates.push(el);
  }
  // Sobe cada candidato para o container de overlay mais externo, evitando
  // fatiar (ex.: cada item `span.overlay__num` do menu vira um overlay). Assim
  // os 3 itens convergem para o `.nav__overlay`/`.menu` que os contém.
  const climb = (el: HTMLElement): HTMLElement => {
    let top = el;
    for (let p = el.parentElement; p; p = p.parentElement) {
      try {
        if (p.matches(SELECTOR)) top = p;
      } catch {
        /* ignora */
      }
    }
    return top;
  };
  const roots = Array.from(new Set(candidates.map(climb)));
  return roots.filter((el) => !roots.some((o) => o !== el && o.contains(el)));
}

/** Força um overlay (e subárvore) visível para capturar o estado aberto. */
function forceOverlayVisible(root: HTMLElement): () => void {
  const undo: (() => void)[] = [];
  const rcs = getComputedStyle(root);
  forceStyle(root, "opacity", "1", undo);
  forceStyle(root, "visibility", "visible", undo);
  if (rcs.display === "none") forceStyle(root, "display", "block", undo);
  if (rcs.transform !== "none") forceStyle(root, "transform", "none", undo);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) === 0) forceStyle(el, "opacity", "1", undo);
    if (cs.visibility === "hidden") forceStyle(el, "visibility", "visible", undo);
  }
  return () => undo.forEach((f) => f());
}

function nextFrame(): Promise<void> {
  // rAF nao dispara em abas em segundo plano - corrida com timeout
  return new Promise((r) => {
    const t = setTimeout(r, 250);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(t);
        r();
      })
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Rola a página inteira até o footer para disparar IntersectionObservers
 * (imagens lazy, seções com scroll-reveal, componentes montados sob demanda).
 * Espera em cada passo para animações/mounts completarem e assenta no rodapé.
 * NÃO volta ao topo — o chamador faz isso após forçar o conteúdo visível.
 */
async function preloadLazyContent(): Promise<void> {
  const step = Math.max(Math.round(innerHeight * 0.8), 200);
  for (let pass = 0; pass < 2; pass++) {
    let y = 0;
    // scrollHeight pode crescer conforme conteúdo é montado — recalcula no loop.
    for (let guard = 0; guard < 80; guard++) {
      const maxY = document.documentElement.scrollHeight - innerHeight;
      if (y >= maxY) break;
      y = Math.min(y + step, maxY);
      scrollTo(0, y);
      await sleep(140);
      await nextFrame();
    }
    // assenta no rodapé para reveals/mounts da última dobra completarem
    scrollTo(0, document.documentElement.scrollHeight);
    await sleep(450);
    await nextFrame();
  }
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

/**
 * Suprime o offset de scroll dentro de subárvores `position:fixed` — fixos são
 * presos à viewport, então sua posição "de página" (como no topo) é o próprio
 * r.top/left. walkElement incrementa/decrementa ao entrar/sair de um fixed.
 * Essencial no scroll-following, que lê elementos com a página rolada.
 */
let fixedScrollSuppressed = 0;
const curScrollX = () => (fixedScrollSuppressed > 0 ? 0 : scrollX);
const curScrollY = () => (fixedScrollSuppressed > 0 ? 0 : scrollY);

function pageRect(r: DOMRect): Rect {
  return {
    x: r.left + curScrollX(),
    y: r.top + curScrollY(),
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

// -------------------------------------------------------------- auto layout

const px = (v: string) => parseFloat(v) || 0;

/** display:flex (row/column ± reverse) ou display:grid → layout no Figma. */
function detectAutoLayout(cs: CSSStyleDeclaration): AutoLayout | null {
  const isFlex = cs.display === "flex" || cs.display === "inline-flex";
  const isGrid = cs.display === "grid" || cs.display === "inline-grid";
  if (!isFlex && !isGrid) return null;

  const paddings = {
    paddingTop: px(cs.paddingTop),
    paddingRight: px(cs.paddingRight),
    paddingBottom: px(cs.paddingBottom),
    paddingLeft: px(cs.paddingLeft),
  };
  const gapPx = (v: string) => (v === "normal" ? 0 : px(v));

  if (isGrid) return gridLayout(cs, paddings, gapPx);
  return flexLayout(cs, paddings, gapPx);
}

type Paddings = Pick<
  AutoLayout,
  "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft"
>;

/**
 * Tamanhos (px) das tracks de um grid-template-* já resolvido pelo computed
 * style. Remove nomes de linha `[...]` e converte cada track em número;
 * descarta o que não resolve em px.
 */
function parseTracks(template: string): number[] {
  if (!template || template === "none") return [];
  return template
    .replace(/\[[^\]]*\]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => parseFloat(t))
    .filter((n) => !isNaN(n));
}

/** Offsets cumulativos (início de cada track), incluindo o gap entre elas. */
function cumulativeStarts(sizes: number[], gap: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < sizes.length; i++) {
    out.push(acc);
    acc += sizes[i] + gap;
  }
  return out;
}

/** Índice da fronteira mais próxima de `value`. */
function nearestIndex(boundaries: number[], value: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < boundaries.length; i++) {
    const d = Math.abs(boundaries[i] - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Deriva a célula (start + span, 0-based) de cada filho de grid casando sua
 * geometria real contra os offsets cumulativos das tracks. Pula filhos
 * `absolute` (out-of-flow).
 */
function computeGridAreas(
  layout: AutoLayout,
  containerRect: Rect,
  cs: CSSStyleDeclaration,
  children: CapturedNode[]
): void {
  const { columnSizes, rowSizes, columnGap, rowGap } = layout;
  if (columnSizes.length < 1) return;
  const originX = containerRect.x + parseFloat(cs.borderLeftWidth) + layout.paddingLeft;
  const originY = containerRect.y + parseFloat(cs.borderTopWidth) + layout.paddingTop;
  const colLeft = cumulativeStarts(columnSizes, columnGap);
  const colRight = colLeft.map((l, i) => l + columnSizes[i]);
  const rowTop = cumulativeStarts(rowSizes, rowGap);
  const rowBottom = rowTop.map((t, i) => t + rowSizes[i]);

  for (const child of children) {
    if (child.absolute) continue;
    const relLeft = child.rect.x - originX;
    const relRight = relLeft + child.rect.width;
    const relTop = child.rect.y - originY;
    const relBottom = relTop + child.rect.height;
    const columnStart = nearestIndex(colLeft, relLeft);
    const columnSpan = Math.max(1, nearestIndex(colRight, relRight) - columnStart + 1);
    const rowStart = rowSizes.length ? nearestIndex(rowTop, relTop) : 0;
    const rowSpan = rowSizes.length
      ? Math.max(1, nearestIndex(rowBottom, relBottom) - rowStart + 1)
      : 1;
    child.gridArea = { columnStart, columnSpan, rowStart, rowSpan };
  }
}

function gridLayout(
  cs: CSSStyleDeclaration,
  paddings: Paddings,
  gapPx: (v: string) => number
): AutoLayout | null {
  const columnSizes = parseTracks(cs.gridTemplateColumns);
  const rowSizes = parseTracks(cs.gridTemplateRows);
  // Sem colunas resolvidas (grid-auto-flow puro) não dá pra reconstruir a grade.
  if (columnSizes.length < 1) return null;
  return {
    mode: "grid",
    direction: "horizontal",
    reverse: false,
    gap: 0,
    columns: columnSizes.length,
    rows: Math.max(rowSizes.length, 1),
    columnSizes,
    rowSizes,
    rowGap: gapPx(cs.rowGap),
    columnGap: gapPx(cs.columnGap),
    ...paddings,
    alignItems: "start",
    justifyContent: "start",
    wrap: false,
  };
}

function flexLayout(
  cs: CSSStyleDeclaration,
  paddings: Paddings,
  gapPx: (v: string) => number
): AutoLayout | null {
  const dir = cs.flexDirection;
  if (!["row", "column", "row-reverse", "column-reverse"].includes(dir)) return null;
  const horizontal = dir === "row" || dir === "row-reverse";
  const reverse = dir.endsWith("-reverse");
  const gapStr = horizontal ? cs.columnGap : cs.rowGap;

  const alignItems: AutoLayout["alignItems"] = cs.alignItems.includes("center")
    ? "center"
    : cs.alignItems.includes("end")
      ? "end"
      : cs.alignItems.includes("baseline")
        ? "baseline"
        : cs.alignItems.includes("start")
          ? "start"
          : "stretch";

  const justifyContent: AutoLayout["justifyContent"] = cs.justifyContent.includes("center")
    ? "center"
    : cs.justifyContent.includes("end")
      ? "end"
      : cs.justifyContent.startsWith("space")
        ? "space-between"
        : "start";

  return {
    mode: "flex",
    direction: horizontal ? "horizontal" : "vertical",
    reverse,
    gap: gapPx(gapStr),
    columns: 0,
    rows: 0,
    columnSizes: [],
    rowSizes: [],
    rowGap: 0,
    columnGap: 0,
    ...paddings,
    alignItems,
    justifyContent,
    wrap: cs.flexWrap === "wrap" || cs.flexWrap === "wrap-reverse",
  };
}

// ------------------------------------------------------------------- walker

/** Elementos a pular no walk atual (overlays capturados à parte). */
const skipInWalk = new Set<Element>();

async function walkElement(el: Element): Promise<CapturedNode | null> {
  if (SKIP_TAGS.has(el.tagName)) return null;
  if (skipInWalk.has(el)) return null;

  const isFixed = getComputedStyle(el).position === "fixed";
  // Scroll-following: traz elementos off-screen à viewport (re-monta conteúdo
  // virtualizado) antes de medir. Fixos não rolam (presos à viewport); dentro
  // de uma subárvore fixa também não.
  if (!isFixed && fixedScrollSuppressed === 0) await scrollIntoViewIfNeeded(el);

  // Sticky pode estar "grudado" (deslocado da posição de fluxo) quando o
  // scroll-following passa por ele. relative ocupa o mesmo lugar no fluxo,
  // então o swap lê o elemento — e a subárvore toda — na posição natural.
  const undoSticky: (() => void)[] = [];
  if (getComputedStyle(el).position === "sticky") {
    forceStyle(el as HTMLElement, "position", "relative", undoSticky);
  }

  if (isFixed) fixedScrollSuppressed++;
  try {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (isInvisible(el, cs, r)) return null;
    // Converte para coordenadas de página JÁ — o scroll-following desce a
    // página durante o walk dos filhos, e pageRect(r) tardio somaria o
    // scroll de depois a um rect medido agora (container deslocado).
    return await buildWalkedNode(el, cs, r, pageRect(r));
  } finally {
    if (isFixed) fixedScrollSuppressed--;
    for (const u of undoSticky) u();
  }
}

async function buildWalkedNode(
  el: Element,
  cs: CSSStyleDeclaration,
  r: DOMRect,
  pr: Rect
): Promise<CapturedNode | null> {
  if (el instanceof SVGSVGElement) return svgNode(el, r);
  if (el instanceof HTMLImageElement) return await imageNode(el, cs, r);

  // Fallback de fidelidade: rasteriza elementos que não reconstruímos bem
  // (canvas/video/filter) como um screenshot recortado da página.
  if (shouldScreenshot(el, cs, r)) {
    const shot = await screenshotElement(el, r);
    if (shot) {
      return {
        type: "image",
        name: `${layerName(el)} (screenshot)`,
        rect: pr,
        src: shot,
        objectFit: "fill",
        borderRadius: parseRadius(cs),
        borders: parseBorders(cs),
        boxShadow: parseShadows(cs.boxShadow),
        opacity: Number(cs.opacity),
      };
    }
    // falhou — segue com a reconstrução normal
  }

  let layout = detectAutoLayout(cs);
  const entries: { key: number; idx: number; node: CapturedNode }[] = [];
  let idx = 0;
  let textLines = 0;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      for (const t of textNodes(child as Text, cs)) {
        entries.push({ key: 0, idx: idx++, node: t });
        textLines++;
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;
      const childCs = getComputedStyle(childEl);
      const node = await walkElement(childEl);
      if (node) {
        if (layout && (childCs.position === "absolute" || childCs.position === "fixed")) {
          node.absolute = true;
        }
        entries.push({ key: paintOrderKey(childCs), idx: idx++, node });
      }
    }
  }
  entries.sort((a, b) => a.key - b.key || a.idx - b.idx);

  // Texto multi-linha direto no flex viraria itens com gap errado - desliga
  if (textLines > 1) layout = null;

  // Grid: deriva a célula (start + span) de cada filho pela geometria real.
  // `pr`, não `r`: os rects dos filhos estão em coordenadas de página, e a
  // origem do grid precisa estar no mesmo sistema (DOMRect passaria no tipo).
  if (layout && layout.mode === "grid") {
    computeGridAreas(layout, pr, cs, entries.map((e) => e.node));
  }

  const styles = await elementStyles(el, cs);
  styles.layout = layout;

  // Pseudo-elementos ::before/::after entram como filhos sintéticos
  // (::before antes do conteúdo, ::after depois — ordem de pintura do CSS).
  const before = await pseudoNode(el, "::before", pr);
  const after = await pseudoNode(el, "::after", pr);
  const children = entries.map((e) => e.node);
  if (before) children.unshift(before);
  if (after) children.push(after);

  // Com rotação, o getBoundingClientRect devolve a AABB da caixa girada;
  // usamos a caixa não-transformada (offset*) e deixamos o Figma rotacionar.
  const rect = styles.rotation !== 0 ? untransformedRect(el, pr) : pr;

  return {
    type: "element",
    tag: el.tagName.toLowerCase(),
    name: layerName(el),
    rect,
    styles,
    children,
  };
}

/**
 * Captura ::before/::after gerados. Sem DOM real não há geometria exata —
 * usamos width/height do computed style e offsets de posicionamento absoluto,
 * com fallback para o canto do content-box do pai. Aproximado por natureza.
 */
async function pseudoNode(
  el: Element,
  which: "::before" | "::after",
  parentRect: Rect // já em coordenadas de página (medido na hora certa do walk)
): Promise<CapturedNode | null> {
  const pcs = getComputedStyle(el, which);
  const content = pcs.content;
  if (!content || content === "none" || content === "normal") return null;
  if (pcs.display === "none" || pcs.visibility === "hidden" || Number(pcs.opacity) === 0)
    return null;

  const w = parseFloat(pcs.width) || 0;
  const h = parseFloat(pcs.height) || 0;
  const strMatch = content.match(/^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/s);
  const text = strMatch ? (strMatch[1] ?? strMatch[2] ?? "").replace(/\\(.)/g, "$1") : null;

  // Posição aproximada relativa ao pai.
  const parentCs = getComputedStyle(el);
  const padLeft = parseFloat(parentCs.borderLeftWidth) + parseFloat(parentCs.paddingLeft);
  const padTop = parseFloat(parentCs.borderTopWidth) + parseFloat(parentCs.paddingTop);
  let x = parentRect.x + padLeft;
  let y = parentRect.y + padTop;
  if (pcs.position === "absolute" || pcs.position === "fixed") {
    if (pcs.left !== "auto") x = parentRect.x + parseFloat(pcs.left);
    else if (pcs.right !== "auto") x = parentRect.x + parentRect.width - parseFloat(pcs.right) - w;
    if (pcs.top !== "auto") y = parentRect.y + parseFloat(pcs.top);
    else if (pcs.bottom !== "auto") y = parentRect.y + parentRect.height - parseFloat(pcs.bottom) - h;
  }

  const name = `${el.tagName.toLowerCase()}${which}`;

  if (text && text.trim()) {
    const styles = textStylesFrom(pcs);
    return {
      type: "text",
      name: `${name} "${text.slice(0, 20)}"`,
      rect: { x, y, width: w || text.length * styles.fontSize * 0.6, height: h || styles.fontSize * 1.3 },
      content: text,
      styles,
    };
  }

  // Caixa decorativa: só vale a pena se for visível e tiver tamanho.
  if (w < 1 || h < 1) return null;
  const styles = await pseudoStyles(pcs, w, h);
  const visible =
    styles.backgroundColor || styles.backgroundLayers.length > 0 || styles.borders;
  if (!visible) return null;
  return { type: "element", tag: which, name, rect: { x, y, width: w, height: h }, styles, children: [] };
}

/** ElementStyles a partir do computed style de um pseudo-elemento. */
async function pseudoStyles(
  pcs: CSSStyleDeclaration,
  w: number,
  h: number
): Promise<ElementStyles> {
  const bg = pcs.backgroundColor;
  const transparent = bg === "rgba(0, 0, 0, 0)" || bg === "transparent";

  const backgroundLayers = await parseBackgroundLayers(
    pcs.backgroundImage,
    pcs.backgroundSize,
    (url) => toDataURL(url, w, h)
  );

  return {
    backgroundColor: transparent ? null : bg,
    backgroundLayers,
    borders: parseBorders(pcs),
    borderRadius: parseRadius(pcs),
    boxShadow: parseShadows(pcs.boxShadow),
    layerBlur: parseBlur(pcs.filter),
    backgroundBlur: parseBlur(pcs.backdropFilter),
    blendMode: parseBlendMode(pcs.mixBlendMode),
    opacity: Number(pcs.opacity),
    overflowHidden: pcs.overflow === "hidden" || pcs.overflow === "clip",
    layout: null,
    rotation: parseRotation(pcs.transform),
  };
}

/** Caixa de layout (sem transform), centrada no mesmo ponto que a AABB girada.
 *  `pr` já está em coordenadas de página (medido na hora certa do walk). */
function untransformedRect(el: Element, pr: Rect): Rect {
  const cx = pr.x + pr.width / 2;
  const cy = pr.y + pr.height / 2;
  const w = (el as HTMLElement).offsetWidth || pr.width;
  const h = (el as HTMLElement).offsetHeight || pr.height;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
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

/** true quando o elemento recorta o background no texto (gradiente em texto). */
function backgroundClipText(cs: CSSStyleDeclaration): boolean {
  return (
    cs.getPropertyValue("-webkit-background-clip").trim() === "text" ||
    cs.getPropertyValue("background-clip").trim() === "text"
  );
}

function textStylesFrom(cs: CSSStyleDeclaration): TextStyles {
  const lh = cs.lineHeight;
  const clipGradient = backgroundClipText(cs) ? parseGradient(cs.backgroundImage) : null;
  return {
    fontFamily: cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, ""),
    fontSize: parseFloat(cs.fontSize),
    fontWeight: Number(cs.fontWeight) || 400,
    fontStyle: cs.fontStyle === "italic" ? "italic" : "normal",
    lineHeight: lh.endsWith("px") ? parseFloat(lh) : null,
    letterSpacing: cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing),
    color: cs.color,
    gradient: clipGradient,
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
    textShadow: parseTextShadows(cs.textShadow),
  };
}

/** text-shadow → sombras (sem spread/inset). Cor pode vir antes ou depois. */
function parseTextShadows(v: string): Shadow[] {
  if (!v || v === "none") return [];
  return splitTopLevel(v).flatMap((part) => {
    const color = part.match(/rgba?\([^)]+\)/)?.[0] ?? "rgba(0,0,0,0.5)";
    const nums = part
      .replace(/rgba?\([^)]+\)/, "")
      .trim()
      .split(/\s+/)
      .map(parseFloat)
      .filter((n) => !isNaN(n));
    if (nums.length < 2) return [];
    const [offsetX, offsetY, blur = 0] = nums;
    return [{ offsetX, offsetY, blur, spread: 0, color, inset: false }];
  });
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
    borders: parseBorders(cs),
    boxShadow: parseShadows(cs.boxShadow),
    opacity: Number(cs.opacity),
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

// ----------------------------------------------------------- screenshot fallback

/** mix-blend-mode → valor CSS, ou null quando normal (não altera o nó). */
function parseBlendMode(value: string): string | null {
  return value && value !== "normal" ? value.trim() : null;
}

/** Raio de um `blur(Npx)` isolado; 0 se o valor não é exatamente um blur. */
function parseBlur(value: string): number {
  if (!value || value === "none") return 0;
  const m = value.trim().match(/^blur\(([\d.]+)px\)$/);
  return m ? parseFloat(m[1]) : 0;
}

/** Elementos cuja reconstrução por nós é fraca → melhor rasterizar. */
function shouldScreenshot(el: Element, cs: CSSStyleDeclaration, r: DOMRect): boolean {
  const tag = el.tagName;
  // filter: blur puro vira efeito nativo (LAYER_BLUR), não screenshot.
  const filterCandidate = cs.filter !== "none" && !!cs.filter && parseBlur(cs.filter) === 0;
  const candidate = tag === "CANVAS" || tag === "VIDEO" || filterCandidate;
  if (!candidate) return false;
  // Precisa caber no viewport (captureVisibleTab só pega a área visível).
  return r.width >= 1 && r.height >= 1 && r.width <= innerWidth && r.height <= innerHeight;
}

/**
 * Rola o elemento para dentro do viewport, captura a aba visível via service
 * worker e recorta a região do elemento (×DPR). Restaura o scroll ao final.
 */
async function screenshotElement(el: Element, r: DOMRect): Promise<string | null> {
  const prevX = scrollX;
  const prevY = scrollY;
  try {
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "center" });
      await nextFrame();
    }
    const rr = el.getBoundingClientRect();
    if (rr.top < 0 || rr.left < 0 || rr.bottom > innerHeight || rr.right > innerWidth) {
      return null; // não coube totalmente no viewport
    }
    const full = await captureViewport();
    if (!full) return null;
    return await cropDataUrl(full, rr, devicePixelRatio || 1);
  } catch {
    return null;
  } finally {
    scrollTo(prevX, prevY);
  }
}

async function captureViewport(): Promise<string | null> {
  try {
    const res = await chrome.runtime.sendMessage({ type: "h2f-screenshot" });
    return res?.ok && typeof res.dataUrl === "string" ? res.dataUrl : null;
  } catch {
    return null;
  }
}

/** Recorta a região (em px CSS de viewport) de um screenshot em escala DPR. */
async function cropDataUrl(dataUrl: string, rr: DOMRect, dpr: number): Promise<string | null> {
  const img = await loadImage(dataUrl);
  if (!img) return null;
  const sx = Math.round(rr.left * dpr);
  const sy = Math.round(rr.top * dpr);
  const sw = Math.max(1, Math.round(rr.width * dpr));
  const sh = Math.max(1, Math.round(rr.height * dpr));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
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
    backgroundLayers: [],
    borders: null,
    borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
    boxShadow: [],
    layerBlur: 0,
    backgroundBlur: 0,
    blendMode: null,
    opacity: 1,
    overflowHidden: false,
    layout: null,
    rotation: 0,
  };
}

async function elementStyles(
  el: Element,
  cs: CSSStyleDeclaration
): Promise<ElementStyles> {
  const bg = cs.backgroundColor;
  const transparent = bg === "rgba(0, 0, 0, 0)" || bg === "transparent";

  // background-clip:text: o background é recortado no texto (vira fill dos
  // TextNodes filhos), então o próprio elemento não pinta nada.
  const clipText = backgroundClipText(cs);
  const backgroundLayers = clipText
    ? []
    : await parseBackgroundLayers(cs.backgroundImage, cs.backgroundSize, (url) => {
        const r = el.getBoundingClientRect();
        return toDataURL(url, r.width, r.height);
      });

  return {
    backgroundColor: transparent || clipText ? null : bg,
    backgroundLayers,
    borders: parseBorders(cs),
    borderRadius: parseRadius(cs),
    boxShadow: parseShadows(cs.boxShadow),
    layerBlur: parseBlur(cs.filter),
    backgroundBlur: parseBlur(cs.backdropFilter),
    blendMode: parseBlendMode(cs.mixBlendMode),
    opacity: Number(cs.opacity),
    overflowHidden: cs.overflow === "hidden" || cs.overflow === "clip",
    layout: null, // preenchido pelo walkElement
    rotation: parseRotation(cs.transform),
  };
}

/**
 * Extrai o ângulo de rotação de uma matriz CSS `transform` (graus, sentido
 * horário). Ignora escala/translação (a translação já está no rect via
 * getBoundingClientRect) e skew. Retorna 0 quando não há rotação relevante.
 */
function parseRotation(transform: string): number {
  if (!transform || transform === "none") return 0;
  const m = transform.match(/matrix\(([^)]+)\)/);
  if (!m) return 0; // matrix3d e afins: fora do escopo
  const [a, b] = m[1].split(",").map((v) => parseFloat(v.trim()));
  if (isNaN(a) || isNaN(b)) return 0;
  // CSS: y cresce para baixo; ângulo horário positivo.
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return Math.abs(deg) < 0.5 ? 0 : deg;
}

/** Lê os 4 lados da borda; retorna null se nenhum lado é visível. */
function parseBorders(cs: CSSStyleDeclaration): Borders | null {
  const side = (
    width: string,
    color: string,
    style: string
  ): SideBorder | null => {
    const w = parseFloat(width);
    if (!(w > 0) || style === "none") return null;
    return {
      width: w,
      color,
      style: (["dashed", "dotted"].includes(style) ? style : "solid") as
        | "solid"
        | "dashed"
        | "dotted",
    };
  };
  const borders: Borders = {
    top: side(cs.borderTopWidth, cs.borderTopColor, cs.borderTopStyle),
    right: side(cs.borderRightWidth, cs.borderRightColor, cs.borderRightStyle),
    bottom: side(cs.borderBottomWidth, cs.borderBottomColor, cs.borderBottomStyle),
    left: side(cs.borderLeftWidth, cs.borderLeftColor, cs.borderLeftStyle),
  };
  return borders.top || borders.right || borders.bottom || borders.left
    ? borders
    : null;
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

/**
 * Separa `background-image` em camadas (ordem do CSS: índice 0 = topo) e
 * resolve cada uma: `url(...)` → imagem (via resolveImage), gradiente → Gradient.
 * Camadas que não resolvem (imagem falha, gradiente null) são descartadas.
 */
async function parseBackgroundLayers(
  bgi: string,
  bgSize: string,
  resolveImage: (url: string) => Promise<string | null>
): Promise<BackgroundLayer[]> {
  if (!bgi || bgi === "none") return [];
  const sizes = splitTopLevel(bgSize);
  const fitFor = (i: number): "FILL" | "FIT" => {
    const s = (sizes[i] ?? sizes[0] ?? "").trim();
    if (s === "contain") return "FIT";
    return "FILL"; // cover, auto, px… → FILL
  };
  const layers: BackgroundLayer[] = [];
  const parts = splitTopLevel(bgi);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const urlMatch = part.match(/url\(["']?([^"')]+)["']?\)/);
    if (urlMatch) {
      const src = await resolveImage(urlMatch[1]);
      if (src) layers.push({ kind: "image", src, scaleMode: fitFor(i) });
    } else {
      const gradient = parseGradient(part);
      if (gradient) layers.push({ kind: "gradient", gradient });
    }
  }
  return layers;
}

const DEFAULT_CENTER = { x: 0.5, y: 0.5 };

/** Parser de linear/radial/conic-gradient (casos comuns do computed style). */
function parseGradient(v: string): Gradient | null {
  const linear = v.match(/^(?:repeating-)?linear-gradient\((.+)\)$/);
  const radial = v.match(/^(?:repeating-)?radial-gradient\((.+)\)$/);
  const conic = v.match(/^(?:repeating-)?conic-gradient\((.+)\)$/);

  if (linear) {
    const parts = splitTopLevel(linear[1]);
    let angle = 180;
    if (parts[0]?.endsWith("deg")) angle = parseFloat(parts.shift()!);
    else if (parts[0]?.startsWith("to ")) {
      const dir = parts.shift()!;
      angle = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 }[dir] ?? 180;
    }
    const stops = parseStops(parts);
    return stops.length >= 2 ? { type: "linear", angle, center: DEFAULT_CENTER, stops } : null;
  }

  if (radial) {
    const parts = splitTopLevel(radial[1]);
    let center = DEFAULT_CENTER;
    // Prefixo opcional de forma/tamanho/posição (sem rgb → não é um color stop).
    if (parts[0] && !/rgba?\(|#[0-9a-fA-F]/.test(parts[0])) {
      center = parseCenter(parts.shift()!);
    }
    const stops = parseStops(parts);
    return stops.length >= 2 ? { type: "radial", angle: 0, center, stops } : null;
  }

  if (conic) {
    const parts = splitTopLevel(conic[1]);
    let angle = 0;
    let center = DEFAULT_CENTER;
    if (parts[0] && /from |\bat /.test(parts[0])) {
      const head = parts.shift()!;
      const fromMatch = head.match(/from\s+([\d.]+)deg/);
      if (fromMatch) angle = parseFloat(fromMatch[1]);
      center = parseCenter(head);
    }
    const stops = parseStops(parts);
    return stops.length >= 2 ? { type: "conic", angle, center, stops } : null;
  }

  return null;
}

/** Extrai os color stops de uma lista de partes top-level já separadas. */
function parseStops(parts: string[]): { color: string; position: number }[] {
  return parts.flatMap((p, i) => {
    const color = p.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/)?.[0];
    if (!color) return [];
    const pos = p.match(/([\d.]+)%/);
    return [{ color, position: pos ? Number(pos[1]) / 100 : i / Math.max(parts.length - 1, 1) }];
  });
}

/** Resolve "at X% Y%" / keywords (center/left/top/right/bottom) → centro 0..1. */
function parseCenter(head: string): { x: number; y: number } {
  const at = head.match(/\bat\s+(.+)$/);
  if (!at) return DEFAULT_CENTER;
  const tokens = at[1].trim().split(/\s+/);
  const axis = (tok: string | undefined, vertical: boolean): number => {
    if (!tok) return 0.5;
    const pct = tok.match(/([\d.]+)%/);
    if (pct) return Number(pct[1]) / 100;
    const map: Record<string, number> = vertical
      ? { top: 0, center: 0.5, bottom: 1 }
      : { left: 0, center: 0.5, right: 1 };
    return map[tok] ?? 0.5;
  };
  return { x: axis(tokens[0], false), y: axis(tokens[1] ?? tokens[0], true) };
}
