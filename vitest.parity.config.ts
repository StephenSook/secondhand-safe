import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { include: ["tests/parity/**/*.test.ts"], environment: "node", testTimeout: 300_000, fileParallelism: false },
});
