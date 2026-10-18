import { describe, expect, test } from "bun:test"
import type { AutomationExecutionThread } from "@mars/types/automations"
import {
  automationExecutionThreadRoute,
  automationExecutionIdentity,
  automationLocalSessionRoute,
} from "../src/react-app/domains/automations/automation-cloud-thread"

function desktopThread(engineKind: string): AutomationExecutionThread {
  return {
    id: "ath_test",
    threadKind: "automation",
    executionLocation: "desktop",
    automationId: "aut_test",
    automationRunId: "arun_test",
    engineKind,
  }
}

function cloudThread(): AutomationExecutionThread {
  return { ...desktopThread("mars-cloud-agent-v1"), executionLocation: "cloud" }
}

describe("Automation execution thread UI", () => {
  test("uses Den's persisted thread identity for receipt navigation", () => {
    expect(automationExecutionThreadRoute(desktopThread("mars-desktop-runner-v1"))).toBe(
      "/automations?automation=aut_test&run=arun_test&thread=ath_test",
    )
  })

  test("labels a desktop-targeted run from its persisted execution location", () => {
    expect(automationExecutionIdentity(desktopThread("future-replaceable-engine"))).toEqual({
      icon: "desktop",
      label: "Desktop",
    })
  })

  test("labels a Web-created run as marsai.click Cloud on Desktop", () => {
    expect(automationExecutionIdentity(cloudThread())).toEqual({
      icon: "cloud",
      label: "marsai.click Cloud",
    })
  })

  test("opens a linked Desktop run in its native local session", () => {
    expect(automationLocalSessionRoute({
      ...desktopThread("mars-desktop-runner-v1"),
      workspaceId: "ws with spaces",
      nativeThreadId: "ses/failed",
    })).toBe("/workspace/ws%20with%20spaces/session/ses%2Ffailed")
    expect(automationLocalSessionRoute(desktopThread("mars-desktop-runner-v1"))).toBeNull()
    expect(automationLocalSessionRoute({
      ...cloudThread(),
      workspaceId: "ws_cloud",
      nativeThreadId: "ses_cloud",
    })).toBeNull()
  })
})
