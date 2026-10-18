// Gateway runtime detection primitives. Leaf module by design: keep it import-free
// so low-level clients can choose same-origin gateway behavior without cycles.
export type MarsGatewayMarker = {
  version?: number;
  build?: string;
};

declare global {
  interface Window {
    __MARS_GATEWAY__?: MarsGatewayMarker;
  }
}

const DEN_AUTH_TOKEN_STORAGE_KEY = "mars.den.authToken";

export function isMarsGatewayRuntime() {
  return typeof window !== "undefined" && window.__MARS_GATEWAY__?.version === 1;
}

export function getMarsGatewayBuild(): string | null {
  if (!isMarsGatewayRuntime()) return null;
  const build = window.__MARS_GATEWAY__?.build?.trim() ?? "";
  return build || null;
}

export function getMarsGatewayOrigin() {
  if (!isMarsGatewayRuntime()) return null;
  const origin = window.location.origin.trim();
  return origin || null;
}

export function readMarsGatewayDenToken() {
  if (!isMarsGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
