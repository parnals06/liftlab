import { defineConfig } from "vite";

/**
 * `base: "./"` keeps the build relocatable: it works at a domain root, under a
 * GitHub Pages subpath, and from a file:// preview, with no rebuild.
 */
export default defineConfig({
  base: "./",
  build: { target: "es2022", sourcemap: true },
  server: { host: true }, // so the phone on the same Wi-Fi can open it
});
