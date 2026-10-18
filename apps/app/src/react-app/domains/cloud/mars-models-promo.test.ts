declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  hasMarsModelsAvailable,
  isMarsModelsPromoEligible,
  isMarsModelsPromoEligibleForDenBaseUrl,
  shouldShowMarsModelsPromo,
  shouldShowMarsModelsSyncing,
  wasMarsModelsStartupPromoShown,
} from "./mars-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("marsai.click Models promo eligibility", () => {
  test("never promotes hosted models: marsai.click has no hosted control plane", () => {
    expect(isMarsModelsPromoEligibleForDenBaseUrl("https://den.example.com/api/den/")).toBe(false);
    expect(isMarsModelsPromoEligible()).toBe(false);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isMarsModelsPromoEligible()).toBe(false);
    expect(shouldShowMarsModelsPromo()).toBe(false);
    expect(wasMarsModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasMarsModelsAvailable", () => {
  test("requires a connected mars provider with at least one model", () => {
    expect(
      hasMarsModelsAvailable({
        providerConnectedIds: ["mars"],
        providers: [{ id: "mars", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasMarsModelsAvailable({
        providerConnectedIds: ["mars"],
        providers: [{ id: "mars", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});

describe("shouldShowMarsModelsSyncing", () => {
  test("only reports a real pending workspace reload", () => {
    expect(shouldShowMarsModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: false,
      reloadPending: true,
    })).toBe(false);
    expect(shouldShowMarsModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: false,
    })).toBe(false);
    expect(shouldShowMarsModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: true,
    })).toBe(true);
  });
});
