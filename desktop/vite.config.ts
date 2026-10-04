import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    watch: { ignored: ['**/release/**', '**/.test-data/**', '**/.electron-cache/**', '**/.builder-cache/**'] },
  },
  build: { outDir: "dist" },
  test: { include: ["src/**/*.test.ts"] },
});
