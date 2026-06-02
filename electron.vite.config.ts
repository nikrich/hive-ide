import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: { input: resolve("src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      rollupOptions: { input: resolve("src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    resolve: { alias: { "@renderer": resolve("src/renderer/src") } },
    build: {
      outDir: resolve("out/renderer"),
      rollupOptions: { input: resolve("src/renderer/index.html") },
    },
  },
});
