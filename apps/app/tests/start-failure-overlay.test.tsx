import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

test("couldn't start: one report, the hint it answers with, and Reset app data after a confirm", async () => {
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
  const technical = "spawn C:\\Program Files\\marsai.click\\resources\\sidecars\\opencode.exe ENOENT";
  const bootState = { phase: "error", routeReady: false, message: "Something went wrong", error: technical };
  mock.module("@/react-app/shell/boot-state", () => ({
    bootOverlayCanHide: () => false,
    useBootOverlayVisible: () => true,
    useBootState: () => bootState,
  }));

  const reportFailure = mock(async (_input: { message?: string | null }) => ({
    category: "engine_missing",
    avHint: "binary_missing",
    hint: { title: "Your antivirus may have removed marsai.click's engine", body: "Open Windows Security > Protection history." },
  }));
  const resetAppData = mock(async () => ({ ok: true, backupDir: "C:\\Users\\Ana\\AppData\\Roaming\\ai.marsai.desktop\\start-reset-20261017-100000" }));
  let confirmAnswer = false;
  const confirms: string[] = [];
  Object.assign(window, {
    __MARS_ELECTRON__: {
      startup: { reportFailure, resetAppData },
      recovery: { list: async () => ({ ok: true, releases: [] }) },
    },
    __marsRecoveryControl: {},
    confirm: (text: string) => {
      confirms.push(text);
      return confirmAnswer;
    },
  });

  const { LoadingOverlay, RESET_APP_DATA_CONFIRM } = await import("../src/react-app/shell/loading-overlay");
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
    expect(container.textContent).toContain("marsai.click couldn't start");
    expect(container.querySelector("[data-testid=start-failure-hint]")?.textContent).toContain("Your antivirus may have removed");
    expect(container.textContent).toContain(technical);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0]?.[0]).toEqual({ message: technical });

    // A second render on the same page does not report again.
    await act(async () => {
      root.render(<LoadingOverlay key="again" />);
    });
    expect(reportFailure).toHaveBeenCalledTimes(1);

    const reset = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reset app data");
    expect(reset).toBeTruthy();
    await act(async () => {
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(confirms).toEqual([RESET_APP_DATA_CONFIRM]);
    expect(RESET_APP_DATA_CONFIRM).toContain("nothing is deleted");
    expect(RESET_APP_DATA_CONFIRM).toContain("Your chats");
    expect(resetAppData).toHaveBeenCalledTimes(0);
    confirmAnswer = true;
    await act(async () => {
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(resetAppData).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain("start-reset-20261017-100000");
    expect(container.textContent).toContain("Restore previous app data");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
