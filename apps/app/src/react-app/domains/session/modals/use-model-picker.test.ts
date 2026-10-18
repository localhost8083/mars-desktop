declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import { filterCloudManagedModelOptions } from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";

describe("filterCloudManagedModelOptions", () => {
  const options = [
    { providerID: "mars", modelID: "cloud-model" },
    { providerID: "lpr_team", modelID: "managed-model" },
    { providerID: "anthropic", modelID: "local-model" },
  ];

  test("hides cached cloud providers after logout", () => {
    expect(filterCloudManagedModelOptions(options, false)).toEqual([
      { providerID: "anthropic", modelID: "local-model" },
    ]);
  });

  test("retains cloud providers while signed in", () => {
    expect(filterCloudManagedModelOptions(options, true)).toEqual(options);
  });
});

describe("useModelPicker option gating", () => {
  // Mirrors the signed-out (API-key) branch in use-model-picker.ts: the
  // embedded mars gateway stays selectable, cloud imports (lpr_*) do not.
  const merged = [
    { providerID: "mars", modelID: "claude-opus-4-7" },
    { providerID: "mars", modelID: "marsai/auto-free" },
    { providerID: "lpr_team", modelID: "managed-model" },
  ];

  test("keeps the mars gateway options while signed out", () => {
    const cloudProvidersEnabled = false;
    const visible = merged.filter((option) =>
      cloudProvidersEnabled
      || option.providerID.trim().toLowerCase() === "mars"
      || !isCloudManagedProviderKey(option.providerID));
    expect(visible).toEqual([
      { providerID: "mars", modelID: "claude-opus-4-7" },
      { providerID: "mars", modelID: "marsai/auto-free" },
    ]);
  });

  test("keeps every provider while signed in", () => {
    const cloudProvidersEnabled = true;
    const visible = merged.filter((option) =>
      cloudProvidersEnabled
      || option.providerID.trim().toLowerCase() === "mars"
      || !isCloudManagedProviderKey(option.providerID));
    expect(visible).toEqual(merged);
  });
});
