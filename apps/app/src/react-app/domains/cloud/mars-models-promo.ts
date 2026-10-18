import { INFERENCE_MODEL_ALIASES } from "@mars/types/den/inference";

import {
  buildDenAuthUrl,
  getDenInferenceUrl,
  isSelfHostedControlPlane,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../app/lib/den";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useSyncExternalStore } from "react";

export const MARS_MODELS_PROVIDER_ID = "mars";
export const MARS_MODELS_PROVIDER_NAME = "marsai.click Models";
export const MARS_MODELS_PROMO_HIDDEN_KEY = "mars.marsModelsPromo.hidden";
export const MARS_MODELS_PROMO_LAST_SHOWN_KEY = "mars.marsModelsPromo.lastShownAt";
export const MARS_MODELS_STARTUP_PROMO_SHOWN_KEY = "mars.marsModelsPromo.startupShown";
export const marsModelsPromoChangedEvent = "mars-mars-models-promo-changed";
export const MARS_MODELS_PROMO_SHOW_DELAY_MS = 4_000;
export const MARS_MODELS_PROMO_VISIBLE_MS = 14_000;
export const MARS_MODELS_PROMO_REPEAT_MS = 6 * 60 * 60 * 1000;

export function areMarsModelsPromosDisabled() {
  if (/^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_DISABLE_MARS_MODELS ?? "").trim())) {
    return true;
  }
  // marsai.click Models are a hosted marsai.click Cloud offering; self-hosted
  // deployments should never see the upsell surfaces.
  return isSelfHostedControlPlane();
}

export function isMarsModelsPromoEligibleForDenBaseUrl(_baseUrl: string) {
  // The promo advertised the hosted marsai.click Cloud models, which no
  // control plane serves any more.
  return !areMarsModelsPromosDisabled();
}

export function isMarsModelsPromoEligible() {
  return isMarsModelsPromoEligibleForDenBaseUrl(readDenSettings().baseUrl);
}

export function useMarsModelsPromoEligibility() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener(denSettingsChangedEvent, notify);
      return () => window.removeEventListener(denSettingsChangedEvent, notify);
    },
    isMarsModelsPromoEligible,
    isMarsModelsPromoEligible,
  );
}

export type MarsModelPreview = {
  id: string;
  title: string;
  subtitle: string;
};

export const MARS_MODEL_PREVIEWS: MarsModelPreview[] = Object.entries(
  INFERENCE_MODEL_ALIASES,
)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    title: model.displayName.replace(/^marsai.click:\s*/, ""),
    subtitle: "marsai.click hosted",
  }));

export function hasMarsModelsProvider(providerIds: readonly string[]) {
  return providerIds.some((id) => id.trim().toLowerCase() === MARS_MODELS_PROVIDER_ID);
}

/** Local engine has marsai.click Models connected with at least one selectable model. */
export function hasMarsModelsAvailable(input: {
  providerConnectedIds: readonly string[];
  providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> | null }>;
}) {
  if (!hasMarsModelsProvider(input.providerConnectedIds)) return false;
  const mars = input.providers.find(
    (provider) => provider.id.trim().toLowerCase() === MARS_MODELS_PROVIDER_ID,
  );
  return Object.keys(mars?.models ?? {}).length > 0;
}

export function shouldShowMarsModelsSyncing(input: {
  entitled: boolean;
  available: boolean;
  workspaceReady: boolean;
  reloadPending: boolean;
}) {
  return input.entitled && !input.available && input.workspaceReady && input.reloadPending;
}

export function getMarsModelsActionUrl(
  isSignedIn: boolean,
  authMode: "sign-in" | "sign-up" = "sign-in",
) {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl || readDenBootstrapConfig().baseUrl;
  // Signed-in users go straight to the marsai.click Models page — the value-prop
  // + subscribe surface — never to a bare auth or billing page.
  return isSignedIn ? getDenInferenceUrl(baseUrl) : buildDenAuthUrl(baseUrl, authMode);
}

export function isMarsModelsPromoHidden() {
  if (areMarsModelsPromosDisabled()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MARS_MODELS_PROMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideMarsModelsPromo() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MARS_MODELS_PROMO_HIDDEN_KEY, "1");
    window.dispatchEvent(new Event(marsModelsPromoChangedEvent));
  } catch {}
}

export function wasMarsModelsStartupPromoShown() {
  if (!isMarsModelsPromoEligible()) return true;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(MARS_MODELS_STARTUP_PROMO_SHOWN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markMarsModelsStartupPromoShown() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MARS_MODELS_STARTUP_PROMO_SHOWN_KEY, "1");
  } catch {}
}

export function shouldShowMarsModelsPromo(now = Date.now()) {
  if (!isMarsModelsPromoEligible() || typeof window === "undefined" || isMarsModelsPromoHidden()) return false;
  try {
    const lastShown = Number(window.localStorage.getItem(MARS_MODELS_PROMO_LAST_SHOWN_KEY) ?? "0");
    return !Number.isFinite(lastShown) || now - lastShown >= MARS_MODELS_PROMO_REPEAT_MS;
  } catch {
    return true;
  }
}

export function markMarsModelsPromoShown(now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MARS_MODELS_PROMO_LAST_SHOWN_KEY, String(now));
  } catch {}
}
