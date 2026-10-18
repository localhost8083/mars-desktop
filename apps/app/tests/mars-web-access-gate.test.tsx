import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { parseDenMarsWebAccess } from "../src/app/lib/den";
import {
  denWebBillingUrl,
  MarsWebAccessGateScreen,
  resolveMarsWebAccessGateState,
} from "../src/react-app/domains/cloud/mars-web-access-gate";

const originalWindow = globalThis.window;

function withWindowOrigin(origin: string | null, run: () => void) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: origin === null ? undefined : { location: { origin } },
  });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
}

function billingWeb(input: Record<string, unknown>) {
  return { billing: { stripe: { web: input } } };
}

describe("marsai.click Web access payload", () => {
  test("accepts subscription and complimentary access authored by Den", () => {
    expect(parseDenMarsWebAccess(billingWeb({
      hasAccess: true,
      accessSource: "subscription",
      hasEligibleSubscription: true,
      complimentaryAccess: false,
    }))).toEqual({ hasAccess: true, accessSource: "subscription" });

    expect(parseDenMarsWebAccess(billingWeb({
      hasAccess: true,
      accessSource: "complimentary",
      hasEligibleSubscription: false,
      complimentaryAccess: true,
    }))).toEqual({ hasAccess: true, accessSource: "complimentary" });
  });

  test("accepts a Den denial and rejects inconsistent access claims", () => {
    expect(parseDenMarsWebAccess(billingWeb({
      hasAccess: false,
      accessSource: null,
      hasEligibleSubscription: false,
      complimentaryAccess: false,
    }))).toEqual({ hasAccess: false, accessSource: null });

    expect(parseDenMarsWebAccess(billingWeb({
      hasAccess: true,
      accessSource: null,
      hasEligibleSubscription: false,
      complimentaryAccess: false,
    }))).toBeNull();
    expect(parseDenMarsWebAccess(billingWeb({
      hasAccess: true,
      accessSource: "complimentary",
      hasEligibleSubscription: false,
      complimentaryAccess: false,
    }))).toBeNull();
  });
});

describe("marsai.click Web product-origin gate", () => {
  const identity = { principalId: "user_1", organizationId: "org_1" };
  const scope = "user_1\u0000org_1\u0000token_1";

  test("stays closed until the current principal and organization have a matching result", () => {
    const base = {
      gatewayMode: true,
      authStatus: "signed_in" as const,
      authToken: "token_1",
      organizationId: "org_1",
      verifiedIdentity: identity,
      expectedScope: scope,
    };

    expect(resolveMarsWebAccessGateState({ ...base, check: null })).toBe("checking");
    expect(resolveMarsWebAccessGateState({
      ...base,
      check: { scope: "user_1\u0000org_other\u0000token_1", state: "granted", accessSource: "complimentary" },
    })).toBe("checking");
    expect(resolveMarsWebAccessGateState({
      ...base,
      check: { scope, state: "denied", accessSource: null },
    })).toBe("denied");
    expect(resolveMarsWebAccessGateState({
      ...base,
      check: { scope, state: "granted", accessSource: "complimentary" },
    })).toBe("granted");
  });

  test("fails closed when Den is unavailable and stays inert outside the gateway", () => {
    expect(resolveMarsWebAccessGateState({
      gatewayMode: true,
      authStatus: "unavailable",
      authToken: "token_1",
      organizationId: "org_1",
      verifiedIdentity: identity,
      expectedScope: scope,
      check: { scope, state: "granted", accessSource: "subscription" },
    })).toBe("error");

    expect(resolveMarsWebAccessGateState({
      gatewayMode: false,
      authStatus: "signed_in",
      authToken: "token_1",
      organizationId: "org_1",
      verifiedIdentity: identity,
      expectedScope: scope,
      check: null,
    })).toBe("inactive");
  });

  test("renders distinct Den-denied and unavailable recovery surfaces", () => {
    const denied = renderToStaticMarkup(
      <MarsWebAccessGateScreen
        state="denied"
        organizationName="Acme"
        onManageAccess={() => {}}
        onRetry={() => {}}
        onSignOut={() => {}}
      />,
    );
    expect(denied).toContain('data-state="denied"');
    expect(denied).toContain("complimentary admin grant");
    expect(denied).toContain("Manage access in Den");
    expect(denied).toContain("Check again");

    const unavailable = renderToStaticMarkup(
      <MarsWebAccessGateScreen
        state="error"
        organizationName="Acme"
        onManageAccess={() => {}}
        onRetry={() => {}}
        onSignOut={() => {}}
      />,
    );
    expect(unavailable).toContain('data-state="error"');
    expect(unavailable).toContain("marsai.click Web remains locked");
    expect(unavailable).toContain("Retry");
  });
});

describe("marsai.click Web billing URL", () => {
  test("resolves the billing page on the configured Den web base", () => {
    expect(denWebBillingUrl("https://den.example.test/")).toBe("https://den.example.test/dashboard/web");
    expect(denWebBillingUrl("https://den.example.test/api/den")).toBe("https://den.example.test/dashboard/web");
  });

  test("falls back to the page origin behind the gateway when no Den base is configured", () => {
    withWindowOrigin("https://gw.example", () => {
      expect(denWebBillingUrl("")).toBe("https://gw.example/dashboard/web");
      expect(denWebBillingUrl("   ")).toBe("https://gw.example/dashboard/web");
    });
  });

  test("never invents a link from a non-web origin or without a window", () => {
    withWindowOrigin("file://", () => {
      expect(denWebBillingUrl("")).toBe("");
    });
    withWindowOrigin(null, () => {
      expect(denWebBillingUrl("")).toBe("");
    });
  });
});
