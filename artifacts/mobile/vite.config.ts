import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    // Capacitor copies dist/ into android/app/src/main/assets/public on `cap sync`.
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: true,   // expose on LAN so a physical device can hit `vite dev`
    port: 5174,
  },
});
