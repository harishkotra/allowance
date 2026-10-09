import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = `http://127.0.0.1:${process.env.PORT ?? 3011}`;

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  // Bind IPv4 explicitly so a second Vite instance cannot silently share 5173
  // on IPv6 and make port probes report the wrong app.
  server: {
    host: "127.0.0.1",
    port: Number(process.env.CLIENT_PORT ?? 5173),
    strictPort: false,
    proxy: {
      "/api": { target: API, changeOrigin: false },
    },
  },
  plugins: [react(), tailwindcss()],
});
