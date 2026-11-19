import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemon = process.env.CREWPIP_URL ?? "http://127.0.0.1:7357";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": daemon,
      "/ws": { target: daemon.replace(/^http/, "ws"), ws: true },
    },
  },
});
