import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the page runs on Vite and the API on `wrangler dev` (port
// 8787); the proxy keeps them on one origin so the session cookie works.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
