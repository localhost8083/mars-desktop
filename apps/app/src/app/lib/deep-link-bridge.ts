export const deepLinkBridgeEvent = "mars:deep-link";
export const nativeDeepLinkEvent = "mars:deep-link-native";

export type DeepLinkBridgeDetail = {
  urls: string[];
};

declare global {
  interface Window {
    __MARS__?: {
      deepLinks?: string[];
    };
  }
}

function normalizeDeepLinks(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    const trimmed = url.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function pushPendingDeepLinks(target: Window, urls: readonly string[]): string[] {
  const normalized = normalizeDeepLinks(urls);
  if (normalized.length === 0) {
    return [];
  }

  target.__MARS__ ??= {};
  const pending = target.__MARS__.deepLinks ?? [];
  target.__MARS__.deepLinks = [...pending, ...normalized];
  target.dispatchEvent(
    new CustomEvent<DeepLinkBridgeDetail>(deepLinkBridgeEvent, {
      detail: { urls: normalized },
    }),
  );
  return normalized;
}

export function drainPendingDeepLinks(target: Window): string[] {
  const pending = target.__MARS__?.deepLinks ?? [];
  if (target.__MARS__) {
    target.__MARS__.deepLinks = [];
  }
  return [...pending];
}
