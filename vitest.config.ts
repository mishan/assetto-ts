import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts"], environment: "node" },
  // From source, as tsconfig.json resolves it, so tests need no build first.
  resolve: {
    alias: {
      "ac-cardata": fileURLToPath(new URL("./packages/ac-cardata/src/index.ts", import.meta.url)),
    },
  },
})
