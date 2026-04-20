import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // node:test-based tests run via `pnpm test:node`
      "src/lib/ingestion-text.test.ts",
      "src/lib/slugify.test.ts",
      "src/lib/token-budget.test.ts",
      "src/schemas/ingestion.test.ts",
    ],
  },
});
