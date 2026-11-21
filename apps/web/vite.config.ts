import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.AGENTFLOW_WEB_PORT ?? 4173),
    // The e2e stack needs its exact port; plain dev keeps Vite's fallback to the next free one.
    strictPort: Boolean(process.env.AGENTFLOW_WEB_PORT),
    proxy: {
      "/api": {
        // The Playwright console tests point this at their isolated API.
        target: process.env.AGENTFLOW_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
