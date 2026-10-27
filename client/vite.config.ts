import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = {
  "/rooms": {
    target: "http://127.0.0.1:3001",
    changeOrigin: true,
    ws: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy,
  },
  preview: {
    proxy,
  },
});