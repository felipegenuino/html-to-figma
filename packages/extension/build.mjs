import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const copy = (src, dest) => writeFileSync(dest, readFileSync(src));

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/popup.ts", "src/content.ts", "src/background.ts"],
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "chrome110",
  minify: false,
  sourcemap: false,
});

copy("manifest.json", "dist/manifest.json");
copy("src/popup.html", "dist/popup.html");

console.log("extension built -> packages/extension/dist");
