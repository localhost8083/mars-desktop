import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@mars/review"],
};
export default config;
