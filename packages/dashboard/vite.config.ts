import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

import { trailstepDashboardPlugin } from "./src/server/vite-plugin";

export default defineConfig(({ command }) => ({
  build: {
    target: "es2022",
  },
  plugins: [svelte(), ...(command === "serve" ? [trailstepDashboardPlugin()] : [])],
}));
