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
        manualChunks: {
          three: ["three"],
          fiber: ["@react-three/fiber", "@react-three/drei"],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
