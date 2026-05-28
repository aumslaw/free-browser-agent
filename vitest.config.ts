import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [preact() as any],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Default environment is node; dom-ops.test.ts and markdown.test.tsx
    // override via environmentMatchGlobs.
    environment: "node",
    environmentMatchGlobs: [
      ["test/dom-ops.test.ts", "jsdom"],
      ["test/markdown.test.tsx", "jsdom"],
    ],
    // Exclude Playwright e2e — those run via pnpm test:e2e
    exclude: ["test/e2e/**", "**/node_modules/**"],
    // Module isolation so vi.mock() hoisting works correctly per file
    isolate: true,
  },
});
