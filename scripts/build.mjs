import { execSync } from "node:child_process";

execSync("pnpm --filter @mars/desktop build", { stdio: "inherit" });
