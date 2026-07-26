import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // The runtime grading-workspace suite RENDERS real production components with
  // react-dom/server. tsconfig uses `jsx: "preserve"` (Vite's React plugin does
  // the transform for the app build), so vitest's own esbuild pass must be told
  // to use the automatic runtime — otherwise a component that relies on React
  // 17+ implicit JSX fails with "React is not defined" under test only.
  // Transform setting only: no new dependency, no change to the app build.
  esbuild: { jsx: "automatic" },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
