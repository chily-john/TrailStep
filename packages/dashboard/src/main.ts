import { mount } from "svelte";

import App from "./App.svelte";

const target = document.getElementById("app");

if (!target) {
  throw new Error("Dashboard app mount target #app was not found.");
}

const app = mount(App, { target });

export default app;
