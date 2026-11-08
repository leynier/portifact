import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
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

/**
 * HTML entries: the landing, the legal pages and the MCP compatibility page on portifact.com,
 * and the dashboard and auth pages and the public report page on app.portifact.com.
 */
const pages = [
  "index",
  "terms",
  "privacy",
  "acceptable-use",
  "mcp-compatibility",
  "dashboard",
  "login",
  "device",
  "consent",
  "report",
];

export default defineConfig({
  plugins: [react(), tailwindcss(), brandAssets()],
  server: { fs: { allow: ["../.."] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(
        pages.map((page) => [page, fileURLToPath(new URL(`./${page}.html`, import.meta.url))]),
      ),
    },
  },
});
