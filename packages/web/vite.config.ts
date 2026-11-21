import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The server the development page talks to: `npm run serve:dev`, or the one `npm run dev:desktop`
 * starts on 8080. `CHIEF_DEV_API` moves it, which is what the proxy case in the e2e suite does.
 */
const api = process.env.CHIEF_DEV_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // The server answers only its own Host and Origin (packages/chief/src/server/app.ts), and the page
    // is on Vite's port, so the proxy has to be the server's stand-in for both. Development only:
    // a build is served by the server itself and never goes through this.
    proxy: {
      "/api": {
        target: api,
        changeOrigin: true,
        configure(proxy) { proxy.on("proxyReq", (req: { setHeader(name: string, value: string): void }) => req.setHeader("origin", api)); },
      },
    },
  },
});
