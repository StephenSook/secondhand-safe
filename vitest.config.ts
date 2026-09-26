import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.live.test.ts", "tests/e2e/**", "node_modules/**"],
    environment: "node",
  },
});
