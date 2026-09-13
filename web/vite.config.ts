import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1/chat": "http://127.0.0.1:4000",
      "/api": "http://127.0.0.1:4000",
      "/health": "http://127.0.0.1:4000",
      "/mcp": "http://127.0.0.1:4000",
    },
  },
  build: {
    outDir: "dist",
    target: "es2020",
  },
});