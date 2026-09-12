import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/runtime/**', '**/halora-app*/**', '**/release/**', '**/pack-out/**'],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
