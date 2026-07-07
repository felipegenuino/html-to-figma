/**
 * Reproduz a captura real em Chrome headless via DevTools Protocol:
 * builda o capture (esbuild, em memória), carrega fixture.html, injeta o
 * bundle e devolve o JSON da captura no stdout.
 * Uso: node test/run_capture.mjs [url] > test/out.json
 * (sem argumento usa test/fixture.html; com URL faz smoke test em página real)
 */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222;
const fixtureUrl = process.argv[2] ?? pathToFileURL(join(__dirname, "fixture.html")).href;

// Reconstrói o bundle de captura a cada execução (sem artefato commitado).
const built = await esbuild.build({
  entryPoints: [join(__dirname, "_capture_entry.ts")],
  bundle: true,
  format: "iife",
  write: false,
  logLevel: "silent",
});
const bundle = built.outputFiles[0].text;

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1200,2000",
  "--force-device-scale-factor=1",
  fixtureUrl,
]);

const log = (...a) => console.error(...a);
process.on("exit", () => chrome.kill());

async function getJSON(path) {
  const res = await fetch(`http://localhost:${PORT}${path}`);
  return res.json();
}

async function waitForTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await getJSON("/json");
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome não subiu o target de página");
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

(async () => {
  const page = await waitForTarget();
  log("target:", page.url);
  const { ready, send, close } = cdp(page.webSocketDebuggerUrl);
  await ready;
  await send("Page.enable");
  await send("Runtime.enable");
  // espera o load completar
  await new Promise((r) => setTimeout(r, 500));

  // injeta o bundle
  await send("Runtime.evaluate", { expression: bundle, includeCommandLineAPI: true });

  // roda a captura
  const result = await send("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await window.__h2fCapture(document.body)))()`,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    log("ERRO na captura:", JSON.stringify(result.exceptionDetails, null, 2));
    close();
    process.exit(1);
  }
  process.stdout.write(result.result.value);
  close();
  setTimeout(() => process.exit(0), 100);
})().catch((e) => {
  log("FALHA:", e);
  process.exit(1);
});
