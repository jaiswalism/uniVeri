import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/core/**/*.test.ts",
      "test/services/**/*.test.ts",
      "test/verifier/**/*.test.ts",
      "test/benchmark/**/*.test.ts",
    ],
    exclude: ["test/contracts/**", "node_modules/**", "dist/**"],
  },
});
