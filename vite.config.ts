import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "src"),
  base: "./",
  publicDir: path.resolve(__dirname, "public"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/three")) return "three";
          if (
            id.includes("@react-three/fiber") ||
            id.includes("@react-three/drei")
          )
            return "fiber";
        },
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
