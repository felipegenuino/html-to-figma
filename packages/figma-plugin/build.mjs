import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const copy = (src, dest) => writeFileSync(dest, readFileSync(src));

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  format: "iife",
  target: "es2017",
  minify: false,
});

copy("src/ui.html", "dist/ui.html");

console.log("figma plugin built -> packages/figma-plugin/dist");
