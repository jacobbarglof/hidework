import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  clearScreen: false,
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 1500 },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/target/**"] } },
});
