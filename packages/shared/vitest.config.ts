import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@studio/source"] },
  ssr: { resolve: { conditions: ["@studio/source"] } },
  test: { include: ["test/**/*.test.ts"] },
});
