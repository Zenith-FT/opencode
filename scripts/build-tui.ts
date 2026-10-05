// Génère plugin/tui.mjs (rendu OpenTUI/Solid) depuis plugin/tui.tsx.  Usage : bun scripts/build-tui.ts
import solidTransformPlugin from "@opentui/solid/bun-plugin"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..", "plugin")
const result = await Bun.build({
  entrypoints: [path.join(root, "tui.tsx")],
  outdir: root,
  naming: { entry: "[name].mjs" },
  format: "esm",
  target: "node",
  external: ["@opentui/core", "@opentui/solid", "@opentui/solid/jsx-runtime", "solid-js", "solid-js/web"],
  plugins: [solidTransformPlugin],
  minify: false,
  splitting: false,
})
if (!result.success) {
  console.error("build tui échoué", result.logs)
  process.exit(1)
}
console.log("OK plugin/tui.mjs")
