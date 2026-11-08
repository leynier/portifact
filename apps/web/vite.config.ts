import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const brandDir = fileURLToPath(new URL("../../assets/brand/", import.meta.url));

/** Files from assets/brand published at fixed URLs, so they are never duplicated in the repo. */
const brandFiles: Record<string, string> = {
  "favicon.svg": "favicon-32.svg",
  "favicon.ico": "favicon.ico",
  "brand/symbol.png": "symbol.png",
};

function brandAssets(): Plugin {
  return {
    name: "portifact-brand-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const source = brandFiles[(req.url ?? "").replace(/^\//, "")];
        if (!source) return next();
        res.end(readFileSync(`${brandDir}${source}`));
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(brandFiles)) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(`${brandDir}${source}`) });
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), brandAssets()],
  server: { fs: { allow: ["../.."] } },
  build: { outDir: "dist", emptyOutDir: true },
});
