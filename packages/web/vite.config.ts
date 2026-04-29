import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const webHost = process.env.WEB_HOST ?? "127.0.0.1";
const apiHost = process.env.API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    host: webHost,
    port: webPort,
    proxy: {
      "/api": {
        target: `http://${apiHost}:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
