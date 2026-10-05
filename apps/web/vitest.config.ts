import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@studio/source"],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  ssr: { resolve: { conditions: ["@studio/source"] } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
