import { cpSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/background.ts", "src/options.ts", "src/popup.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "chrome116",
  outdir: "dist",
});

await build({
  entryPoints: ["src/content.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "chrome116",
  outdir: "dist",
});

cpSync("static", "dist", { recursive: true });
