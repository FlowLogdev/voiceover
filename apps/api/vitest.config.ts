import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    // `dist/**` matters: `pnpm build` (which CI runs before `pnpm test`) compiles
    // src/**/*.test.ts into dist/**/*.test.js, and vitest's default include
    // pattern matches compiled .test.js just as happily as source .test.ts —
    // without this, every test here runs twice, and the *.integration.test.ts
    // exclude below doesn't catch the compiled .integration.test.js copy at all.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
