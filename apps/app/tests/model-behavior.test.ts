import { afterEach, describe, expect, test } from "bun:test";

import type { ProviderListItem } from "../src/app/types";
import { DEFAULT_MODEL, MODEL_PREF_KEY, MARS_REASONING_EFFORTS } from "../src/app/constants";
import { readStoredDefaultModel } from "../src/react-app/kernel/model-config";
import {
  getModelBehaviorOptions,
  getModelBehaviorSummary,
  nextModelBehaviorValue,
  previousModelBehaviorValue,
} from "../src/app/lib/model-behavior";
import {
  dedupeModelOptions,
  resolveModelDisplayName,
  resolveModelProviderDisplayName,
  resolveModelProviderIconId,
  resolveMarsModelGroup,
} from "../src/app/utils";
import {
  isDirectModelProvider,
  isInternalModelProvider,
  isSupportedModelProvider,
  providerCatalogRank,
} from "../src/app/lib/provider-catalog";

type ProviderModel = ProviderListItem["models"][string];

const model: ProviderModel = {
  id: "gpt-5.3-codex",
  providerID: "openai",
  api: {
    id: "gpt-5.3-codex",
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "GPT-5.3 Codex",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 1,
    output: 1,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {
    none: {},
    low: {},
    medium: {},
    high: {},
    xhigh: {},
    max: {},
  },
};

const marsModel = (id: string, name: string): ProviderModel => ({
  ...model,
  id,
  name,
  providerID: "mars",
  api: { id, url: "http://127.0.0.1:8090/mars-gateway/v1", npm: "@ai-sdk/openai" },
  variants: {
    low: { reasoning_effort: "low" },
    high: { reasoning_effort: "high" },
    xhigh: { reasoning_effort: "xhigh" },
    max: { reasoning_effort: "max" },
  },
});

const MARS_MODELS = [
  marsModel("gpt-6-astra", "GPT 6 Astra"),
  marsModel("gpt-5.6-sol", "GPT-5.6 Sol"),
];

describe("model behavior options", () => {
  test("offers low, high, xhigh and max for every marsai.click model", () => {
    for (const internal of MARS_MODELS) {
      const options = getModelBehaviorOptions("mars", internal, "marsai.click");
      expect(options.map(({ value, label }) => ({ value, label }))).toEqual([
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Xhigh" },
        { value: "max", label: "Max" },
      ]);
      expect(nextModelBehaviorValue(options, "xhigh")).toBe("max");
      expect(nextModelBehaviorValue(options, "max")).toBe("low");
      expect(previousModelBehaviorValue(options, "low")).toBe("max");

      const summary = getModelBehaviorSummary("mars", internal, "max", "marsai.click");
      expect(summary.value).toBe("max");
      expect(summary.label).toBe("Max");
      expect(getModelBehaviorSummary("mars", internal, null, "marsai.click").value).toBe("high");
    }
  });

  test("offers each marsai.click model exactly the efforts the engine reports for it", () => {
    expect([...MARS_REASONING_EFFORTS]).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    // The server declares every other effort disabled per model, so the
    // engine reports only the catalog's levels; anything outside the known
    // set (an engine default such as "ultra") still stays off the picker.
    const museSpark: ProviderModel = {
      ...marsModel("meta-muse-spark", "Meta Muse Spark"),
      family: "Meta Muse",
      variants: {
        minimal: { reasoning_effort: "minimal" },
        low: { reasoning_effort: "low" },
        medium: { reasoning_effort: "medium", reasoningEffort: "medium", reasoningSummary: "auto" },
        high: { reasoning_effort: "high" },
        xhigh: { reasoning_effort: "xhigh" },
        ultra: { reasoningEffort: "ultra" },
      },
    };
    const options = getModelBehaviorOptions("mars", museSpark, "marsai.click");
    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(getModelBehaviorSummary("mars", museSpark, null, "marsai.click").value).toBe("medium");
    expect(getModelBehaviorSummary("mars", museSpark, "xhigh", "marsai.click").value).toBe("xhigh");
    // An effort Muse does not offer (Astra's max) falls back to its default.
    expect(getModelBehaviorSummary("mars", museSpark, "max", "marsai.click").value).toBe("medium");
    expect(getModelBehaviorSummary("mars", museSpark, "ultra", "marsai.click").value).toBe("medium");

    // Astra and Sol keep their v1.0.9 levels and default.
    for (const internal of MARS_MODELS) {
      expect(getModelBehaviorOptions("mars", internal, "marsai.click").map((option) => option.value)).toEqual(["low", "high", "xhigh", "max"]);
      expect(getModelBehaviorSummary("mars", internal, null, "marsai.click").value).toBe("high");
      expect(getModelBehaviorSummary("mars", internal, "medium", "marsai.click").value).toBe("high");
    }
  });

  test("groups Meta Muse under its own family and keeps Astra and Sol under the provider", () => {
    expect(resolveMarsModelGroup("mars", "Meta Muse")).toBe("Meta Muse");
    expect(resolveMarsModelGroup("mars", undefined)).toBeUndefined();
    expect(resolveMarsModelGroup("mars", "  ")).toBeUndefined();
    // Only the marsai.click catalog's families group; other providers keep theirs.
    expect(resolveMarsModelGroup("openai", "gpt")).toBeUndefined();
    expect(resolveModelDisplayName("meta-muse-spark", "Meta Muse Spark")).toBe("Meta Muse Spark");
    expect(resolveModelDisplayName("muse-spark-1.3", "Meta Muse Spark 1.3")).toBe("Meta Muse Spark 1.3");
    expect(resolveModelProviderDisplayName("mars", "muse-spark-1.3", "marsai.click")).toBe("marsai.click");
  });

  test("names a catalog model the app has never heard of by the catalog's display name", () => {
    expect(resolveModelDisplayName("gpt-6.1-sol", "GPT 6.1 Sol")).toBe("GPT 6.1 Sol");
    // A new id that contains a known one keeps its own catalog name.
    expect(resolveModelDisplayName("gpt-6-sol-mini", "GPT 6 Sol Mini")).toBe("GPT 6 Sol Mini");
    expect(resolveModelDisplayName("nova-9.0.1-preview", "Nova 9.0.1 Preview")).toBe("Nova 9.0.1 Preview");
    // A reported name that is only the raw id is humanized as before.
    expect(resolveModelDisplayName("nova-9.0.1-preview", "nova-9.0.1-preview")).toBe("nova-9.0.1-preview");
    expect(resolveModelDisplayName("nova-9.0.1-preview")).toBe("Nova 9.0.1 Preview");
  });

  test("shows both marsai.click models under the marsai.click provider with their display names", () => {
    expect(MARS_MODELS.map((internal) => resolveModelDisplayName(internal.id, internal.name)))
      .toEqual(["GPT 6 Astra", "GPT-5.6 Sol"]);
    for (const internal of MARS_MODELS) {
      expect(resolveModelProviderDisplayName("mars", internal.id, "marsai.click", internal.name)).toBe("marsai.click");
      expect(resolveModelProviderIconId("mars", internal.id, internal.name)).toBe("mars");
    }
    expect(dedupeModelOptions([
      { providerID: "mars", modelID: "gpt-6-astra" },
      { providerID: "mars", modelID: "gpt-5.6-sol" },
      { providerID: "mars", modelID: "gpt-6-astra" },
    ])).toEqual([
      { providerID: "mars", modelID: "gpt-6-astra" },
      { providerID: "mars", modelID: "gpt-5.6-sol" },
    ]);
  });

  test("uses only the raw effort values reported by the model", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(options.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Xhigh" },
    ]);
  });

  test("keeps model and provider identities truthful", () => {
    expect(resolveModelDisplayName("gpt-6-astra", "GPT-6 Astra")).toBe("GPT 6 Astra");
    expect(resolveModelProviderDisplayName("mars", "gpt-6-astra")).toBe("marsai.click");
    expect(resolveModelProviderDisplayName("mars", "gpt-5.6-sol")).toBe("marsai.click");
    expect(resolveModelDisplayName("gpt-5.6-sol", "GPT-5.6 Sol")).toBe("GPT-5.6 Sol");
    expect(resolveModelDisplayName("gpt-5.6-terra", "GPT-5.6 Terra")).toBe("GPT-5.6 Terra");
    expect(resolveModelDisplayName("claude-sonnet-4", "Claude Sonnet 4")).toBe("Claude Sonnet 4");
    expect(resolveModelProviderDisplayName("openai", "gpt-5.6-sol", "OpenAI", "GPT-5.6 Sol")).toBe("OpenAI");
    expect(resolveModelProviderIconId("openai", "gpt-5.6-sol", "GPT-5.6 Sol")).toBe("openai");
    expect(dedupeModelOptions([
      { providerID: "openai", modelID: "gpt-5.6-sol" },
      { providerID: "openai", modelID: "gpt-5.6-terra" },
      { providerID: "openai", modelID: "gpt-5.6-sol" },
    ])).toEqual([
      { providerID: "openai", modelID: "gpt-5.6-sol" },
      { providerID: "openai", modelID: "gpt-5.6-terra" },
    ]);
  });

  test("lists marsai.click models only, mainstream providers only behind the flag", () => {
    expect(isInternalModelProvider("mars")).toBe(true);
    expect(isInternalModelProvider("lpr_team")).toBe(true);
    expect(isDirectModelProvider("openai")).toBe(true);
    expect(isDirectModelProvider("anthropic")).toBe(true);
    expect(isSupportedModelProvider("mars")).toBe(true);
    expect(isSupportedModelProvider("lpr_team")).toBe(true);
    expect(isSupportedModelProvider("anthropic")).toBe(false);
    expect(isSupportedModelProvider("google")).toBe(false);
    expect(isSupportedModelProvider("google", true)).toBe(true);
    expect(isSupportedModelProvider("openrouter", true)).toBe(true);
    expect(isSupportedModelProvider("opencode", true)).toBe(false);
    expect(isSupportedModelProvider("ollama", true)).toBe(false);
    expect(providerCatalogRank("mars")).toBeLessThan(providerCatalogRank("openai"));
  });

  test("cycles explicit effort values and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(nextModelBehaviorValue(options, "low")).toBe("high");
    expect(nextModelBehaviorValue(options, "xhigh")).toBe("low");
    expect(nextModelBehaviorValue(options, null)).toBe("low");
  });

  test("does not cycle models with fewer than two effort values", () => {
    expect(nextModelBehaviorValue([], null)).toBeNull();
    expect(nextModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });

  test("cycles explicit effort values backward and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(previousModelBehaviorValue(options, "high")).toBe("low");
    expect(previousModelBehaviorValue(options, "low")).toBe("xhigh");
    expect(previousModelBehaviorValue(options, null)).toBe("xhigh");
  });

  test("does not cycle backward with fewer than two effort values", () => {
    expect(previousModelBehaviorValue([], null)).toBeNull();
    expect(previousModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });
});

describe("stored default model", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  function storeDefault(value: string): Map<string, string> {
    const items = new Map([[MODEL_PREF_KEY, value]]);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => items.get(key) ?? null,
          setItem: (key: string, next: string) => { items.set(key, next); },
        },
        dispatchEvent: () => true,
      },
    });
    return items;
  }

  test("keeps a Meta Muse default instead of resetting it to Astra", () => {
    const items = storeDefault("mars/meta-muse-spark");
    expect(readStoredDefaultModel()).toEqual({ providerID: "mars", modelID: "meta-muse-spark" });
    expect(items.get(MODEL_PREF_KEY)).toBe("mars/meta-muse-spark");
  });

  test("still moves a retired marsai.click route to the default, Astra", () => {
    const items = storeDefault("mars/z-ai/glm-5.2");
    expect(readStoredDefaultModel()).toEqual(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toEqual({ providerID: "mars", modelID: "gpt-6-astra" });
    expect(items.get(MODEL_PREF_KEY)).toBe("mars/gpt-6-astra");
  });
});
