import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

import { trailstepDashboardPlugin } from "./src/server/vite-plugin";

export default defineConfig(({ command }) => ({
  plugins: [svelte(), ...(command === "serve" ? [trailstepDashboardPlugin()] : [])],
}));
