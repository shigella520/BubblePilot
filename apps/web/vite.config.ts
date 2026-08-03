import { resolve } from "node:path";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  publicDir: resolve(import.meta.dirname, "../../assets/brand"),
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.BUBBLEPILOT_API_URL ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/health": {
        target: process.env.BUBBLEPILOT_API_URL ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
