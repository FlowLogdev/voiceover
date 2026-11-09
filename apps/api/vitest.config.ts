import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
