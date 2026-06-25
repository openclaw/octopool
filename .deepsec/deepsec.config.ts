import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "octopool", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
