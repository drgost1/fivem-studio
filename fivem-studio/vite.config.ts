import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build config. Electron's main process (electron/) is compiled
// separately by tsc — see electron/tsconfig.json and package.json scripts.
export default defineConfig({
  plugins: [react()],
  base: "./", // load assets via relative paths when opened from file:// in packaged builds
  build: {
    outDir: "dist",
    manifest: "manifest.json",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
