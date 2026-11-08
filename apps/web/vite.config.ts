import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const repoFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * Repository files published at fixed URLs, so they are never duplicated in the repo: the brand
 * assets, and the third-party notices that `bun run notices` generates (served by the app Worker
 * at portifact.com/third-party-notices).
 */
const repoFiles: Record<string, string> = {
  "favicon.svg": repoFile("assets/brand/favicon-32.svg"),
  "favicon.ico": repoFile("assets/brand/favicon.ico"),
  "brand/symbol.png": repoFile("assets/brand/symbol.png"),
  "third-party-notices.txt": repoFile("third-party-notices.md"),
};

function repoAssets(): Plugin {
  return {
    name: "portifact-repo-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const source = repoFiles[(req.url ?? "").replace(/^\//, "")];
        if (!source) return next();
        res.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(repoFiles)) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(source) });
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
  plugins: [react(), tailwindcss(), repoAssets()],
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
