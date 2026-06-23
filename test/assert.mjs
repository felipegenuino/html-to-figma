/**
 * Roda a captura headless (run_capture.mjs) e afirma o shape do CaptureDocument
 * para bordas por lado e gradientes radial/conic. Sai com código 1 se falhar.
 * Uso: node test/assert.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function runCapture() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(__dirname, "run_capture.mjs")]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`run_capture saiu com código ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`JSON inválido da captura: ${e.message}`));
      }
    });
  });
}

/** DFS: primeiro nó cujo `name` contém `substr`. */
function findByName(node, substr) {
  if (node.name && node.name.includes(substr)) return node;
  for (const child of node.children ?? []) {
    const hit = findByName(child, substr);
    if (hit) return hit;
  }
  return null;
}

const failures = [];
function check(label, cond) {
  if (!cond) failures.push(label);
}

const doc = await runCapture();
const root = doc.root;

// --- borda single-side (border-bottom) ---
const single = findByName(root, "single-border");
check("single-border: nó encontrado", !!single);
if (single) {
  const b = single.styles.borders;
  check("single-border: borders presente", !!b);
  if (b) {
    check("single-border: bottom presente", !!b.bottom);
    check("single-border: bottom.width === 3", b.bottom?.width === 3);
    check("single-border: bottom.color cinza", b.bottom?.color?.includes("51, 51, 51"));
    check("single-border: top null", b.top === null);
    check("single-border: left null", b.left === null);
    check("single-border: right null", b.right === null);
  }
}

// --- borda multicolor (acento border-left) ---
const multi = findByName(root, "multi-border");
check("multi-border: nó encontrado", !!multi);
if (multi) {
  const b = multi.styles.borders;
  check("multi-border: borders presente", !!b);
  if (b) {
    check("multi-border: left.width === 4", b.left?.width === 4);
    check("multi-border: left.color azul", b.left?.color?.includes("0, 102, 255"));
    check("multi-border: top.width === 1", b.top?.width === 1);
    check("multi-border: top.color cinza", b.top?.color?.includes("204, 204, 204"));
    check("multi-border: right cinza", b.right?.color?.includes("204, 204, 204"));
    check("multi-border: bottom cinza", b.bottom?.color?.includes("204, 204, 204"));
  }
}

// --- radial-gradient (camada única) ---
const radial = findByName(root, "radial");
check("radial: nó encontrado", !!radial);
if (radial) {
  const layers = radial.styles.backgroundLayers;
  check("radial: 1 camada", layers?.length === 1);
  const g = layers?.[0]?.kind === "gradient" ? layers[0].gradient : null;
  check("radial: type === radial", g?.type === "radial");
  check("radial: center presente", !!g?.center);
  check("radial: >= 2 stops", (g?.stops?.length ?? 0) >= 2);
}

// --- conic-gradient (camada única) ---
const conic = findByName(root, "conic");
check("conic: nó encontrado", !!conic);
if (conic) {
  const layers = conic.styles.backgroundLayers;
  const g = layers?.[0]?.kind === "gradient" ? layers[0].gradient : null;
  check("conic: type === conic", g?.type === "conic");
  check("conic: 3 stops", g?.stops?.length === 3);
}

// --- múltiplas camadas empilhadas ---
const stacked = findByName(root, "stacked-bg");
check("stacked-bg: nó encontrado", !!stacked);
if (stacked) {
  const layers = stacked.styles.backgroundLayers;
  check("stacked-bg: 2 camadas", layers?.length === 2);
  if (layers?.length === 2) {
    // CSS lista o topo primeiro → camada 0 = linear; camada 1 = radial.
    check("stacked-bg: camada 0 gradiente linear", layers[0].kind === "gradient" && layers[0].gradient.type === "linear");
    check("stacked-bg: camada 1 gradiente radial", layers[1].kind === "gradient" && layers[1].gradient.type === "radial");
  }
}

// --- grid com colunas não-uniformes ---
const gridNu = findByName(root, "grid-nu");
check("grid-nu: nó encontrado", !!gridNu);
if (gridNu) {
  const L = gridNu.styles.layout;
  check("grid-nu: layout grid", L?.mode === "grid");
  const cs = L?.columnSizes;
  check("grid-nu: 3 columnSizes", cs?.length === 3);
  if (cs?.length === 3) {
    // 1fr 2fr 1fr → coluna do meio ~2x as das pontas.
    check("grid-nu: coluna do meio maior", cs[1] > cs[0] && cs[1] > cs[2]);
    check("grid-nu: pontas ~iguais", Math.abs(cs[0] - cs[2]) < 1);
    check("grid-nu: proporção ~1:2:1", Math.abs(cs[1] / cs[0] - 2) < 0.15);
  }
}

// --- grid com posicionamento explícito + spans ---
const wide = findByName(root, "div.wide");
check("grid-exp: .wide encontrado", !!wide);
if (wide) {
  const a = wide.gridArea;
  check("grid-exp: .wide tem gridArea", !!a);
  check("grid-exp: .wide columnStart 0", a?.columnStart === 0);
  check("grid-exp: .wide columnSpan 2", a?.columnSpan === 2);
  check("grid-exp: .wide rowStart 0", a?.rowStart === 0);
  check("grid-exp: .wide rowSpan 1", a?.rowSpan === 1);
}
const tall = findByName(root, "div.tall");
check("grid-exp: .tall encontrado", !!tall);
if (tall) {
  const a = tall.gridArea;
  check("grid-exp: .tall tem gridArea", !!a);
  check("grid-exp: .tall columnStart 2", a?.columnStart === 2);
  check("grid-exp: .tall rowStart 0", a?.rowStart === 0);
  check("grid-exp: .tall rowSpan 2", a?.rowSpan === 2);
}
const cy = findByName(root, "div.cy");
if (cy) {
  const a = cy.gridArea;
  check("grid-exp: .cy auto → (row1,col1)", a?.rowStart === 1 && a?.columnStart === 1 && a?.columnSpan === 1);
}

// --- blur (filter / backdrop-filter) ---
const blurred = findByName(root, "blurred");
check("blurred: nó encontrado", !!blurred);
if (blurred) {
  check("blurred: layerBlur === 4", blurred.styles?.layerBlur === 4);
  check("blurred: backgroundBlur 0", blurred.styles?.backgroundBlur === 0);
}
const glass = findByName(root, "glass");
check("glass: nó encontrado", !!glass);
if (glass) {
  check("glass: backgroundBlur === 8", glass.styles?.backgroundBlur === 8);
}

// --- background-size: cover/contain → FILL/FIT ---
const bgContain = findByName(root, "bg-contain");
check("bg-contain: nó encontrado", !!bgContain);
if (bgContain) {
  const l = bgContain.styles?.backgroundLayers?.[0];
  check("bg-contain: camada imagem", l?.kind === "image");
  check("bg-contain: scaleMode FIT", l?.scaleMode === "FIT");
}
const bgCover = findByName(root, "section.bg");
if (bgCover) {
  const l = bgCover.styles?.backgroundLayers?.[0];
  check("bg (cover): scaleMode FILL", l?.kind === "image" && l?.scaleMode === "FILL");
}

// --- mix-blend-mode ---
const blend = findByName(root, "section.blend");
check("blend: nó encontrado", !!blend);
if (blend) {
  check("blend: blendMode multiply", blend.styles?.blendMode === "multiply");
}

// --- text-shadow ---
const tshadow = findByName(root, "sombra");
check("text-shadow: nó de texto encontrado", !!tshadow);
if (tshadow) {
  const sh = tshadow.styles?.textShadow?.[0];
  check("text-shadow: 1 sombra", tshadow.styles?.textShadow?.length === 1);
  check("text-shadow: offsetX 2", sh?.offsetX === 2);
  check("text-shadow: offsetY 3", sh?.offsetY === 3);
  check("text-shadow: blur 4", sh?.blur === 4);
}

// --- texto com gradiente (background-clip: text) ---
const gradTextSection = findByName(root, "section.grad-text");
check("grad-text: seção encontrada", !!gradTextSection);
if (gradTextSection) {
  check("grad-text: bg do elemento limpo", (gradTextSection.styles?.backgroundLayers?.length ?? 0) === 0);
}
const gradText = findByName(root, "degrade");
check("grad-text: nó de texto encontrado", !!gradText);
if (gradText) {
  check("grad-text: texto tem gradiente", gradText.styles?.gradient?.type === "linear");
  check("grad-text: gradiente >= 2 stops", (gradText.styles?.gradient?.stops?.length ?? 0) >= 2);
}

// --- <img> com border/shadow/opacity ---
const imgStyled = findByName(root, "img-styled");
check("img-styled: nó encontrado", !!imgStyled);
if (imgStyled) {
  check("img-styled: é image", imgStyled.type === "image");
  check("img-styled: opacity 0.8", imgStyled.opacity === 0.8);
  check("img-styled: border 2px", imgStyled.borders?.top?.width === 2);
  check("img-styled: 1 box-shadow", imgStyled.boxShadow?.length === 1);
  check("img-styled: shadow blur 8", imgStyled.boxShadow?.[0]?.blur === 8);
}

// --- conteúdo escondido por scroll-reveal deve ser forçado visível ---
const revealed = findByName(root, "revelado");
check("force-reveal: texto escondido foi capturado", !!revealed);
// e a opacity parcial legítima (img 0.8) NÃO pode ser corrompida
if (imgStyled) {
  check("force-reveal: opacity parcial preservada (0.8)", imgStyled.opacity === 0.8);
}

// --- overlay interativo vira frame "click" separado, fora da estática ---
check("overlay: menu NÃO está na versão estática", !findByName(root, "menu-overlay"));
check("overlay: doc.overlays existe", Array.isArray(doc.overlays));
const menuOverlay = (doc.overlays ?? []).map((o) => findByName(o, "Menu Aberto")).find(Boolean);
check("overlay: menu capturado como overlay separado", !!menuOverlay);

// --- scroll-following: conteúdo virtualizado (desmonta off-screen) é capturado ---
const virt = findByName(root, "Virtualizado Visivel");
check("scroll-following: conteúdo virtualizado capturado", !!virt);

if (failures.length) {
  console.error(`\n✗ ${failures.length} asserção(ões) falharam:`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("✓ todas as asserções passaram");
