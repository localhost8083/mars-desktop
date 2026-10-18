import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

test("couldn't start on a read-only store that marks cannot fix: Reset app data leads, no Fix and restart", async () => {
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  // Stable values, as the real providers keep them across renders.
  const desktopConfig = { config: {}, refreshFresh: async () => ({}) };
  const cloudStatus = { gatewayMode: false, visible: false, viewModel: { variant: "hidden" } };
  mock.module("@/react-app/domains/cloud/desktop-config-provider", () => ({
    useDesktopConfig: () => desktopConfig,
  }));
  mock.module("@/react-app/shell/cloud-workspace-overlay", () => ({
    useCloudWorkspaceStatus: () => cloudStatus,
  }));
  const technical = "attempt to write a readonly database";
  const bootState = { phase: "error", routeReady: false, message: "Something went wrong", error: technical };
  mock.module("@/react-app/shell/boot-state", () => ({
    bootOverlayCanHide: () => false,
    useBootOverlayVisible: () => true,
    useBootState: () => bootState,
  }));

  const reportFailure = mock(async (_input: { message?: string | null }) => ({
    category: "store_readonly",
    avHint: "none",
    canRepairStore: false,
    leadWithReset: true,
    hint: { title: "marsai.click can't write its local data", body: "Press Fix and restart." },
  }));
  const repairStore = mock(async () => ({ ok: true, fixed: 2, failed: 0 }));
  Object.assign(window, {
    __MARS_ELECTRON__: {
      startup: { reportFailure, repairStore, resetAppData: async () => ({ ok: true }) },
      recovery: { list: async () => ({ ok: true, releases: [] }) },
    },
    __marsRecoveryControl: {},
  });

  const { LoadingOverlay } = await import("../src/react-app/shell/loading-overlay");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<LoadingOverlay />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid=start-failure-repair-store]")).toBeNull();
    const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons[0]).toBe("Reset app data");
    expect(buttons.filter((text) => text === "Reset app data").length).toBe(1);
    expect(repairStore).toHaveBeenCalledTimes(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
