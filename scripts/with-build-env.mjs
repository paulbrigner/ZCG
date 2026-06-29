import { spawnSync } from "node:child_process";

process.env.BETTER_AUTH_SECRET ??= "phase0-local-build-secret-change-before-deploy";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

const result = spawnSync("next", ["build"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32"
});

process.exit(result.status ?? 1);
