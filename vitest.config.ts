import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Default environment is node; dom-ops.test.ts overrides via
    // @vitest-environment jsdom docblock comment.
    environment: "node",
    environmentMatchGlobs: [
      ["test/dom-ops.test.ts", "jsdom"],
    ],
    // Exclude Playwright e2e — those run via pnpm test:e2e
    exclude: ["test/e2e/**", "**/node_modules/**"],
    // Module isolation so vi.mock() hoisting works correctly per file
    isolate: true,
  },
});
