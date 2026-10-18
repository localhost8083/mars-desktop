export const MARS_DEPLOYMENT_ENV_VAR = "VITE_MARS_DEPLOYMENT";

export type MarsDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): MarsDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getMarsDeployment(): MarsDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_MARS_DEPLOYMENT === "string"
      ? import.meta.env.VITE_MARS_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getMarsDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getMarsDeployment() === "desktop";
}
