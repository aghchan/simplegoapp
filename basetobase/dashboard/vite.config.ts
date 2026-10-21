import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DISPATCH = "http://localhost:8787";

export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: DISPATCH, ws: true },
      "/auth": DISPATCH,
      "/agent": DISPATCH,
    },
  },
});
