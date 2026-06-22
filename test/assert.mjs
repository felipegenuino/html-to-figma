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

// --- radial-gradient ---
const radial = findByName(root, "radial");
check("radial: nó encontrado", !!radial);
if (radial) {
  const g = radial.styles.gradient;
  check("radial: gradient presente", !!g);
  check("radial: type === radial", g?.type === "radial");
  check("radial: center presente", !!g?.center);
  check("radial: >= 2 stops", (g?.stops?.length ?? 0) >= 2);
}

// --- conic-gradient ---
const conic = findByName(root, "conic");
check("conic: nó encontrado", !!conic);
if (conic) {
  const g = conic.styles.gradient;
  check("conic: gradient presente", !!g);
  check("conic: type === conic", g?.type === "conic");
  check("conic: 3 stops", g?.stops?.length === 3);
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} asserção(ões) falharam:`);
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("✓ todas as asserções passaram");
