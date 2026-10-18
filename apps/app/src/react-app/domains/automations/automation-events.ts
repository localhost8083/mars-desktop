export const automationsStateChangedEvent = "mars:automations-state-changed"

export function dispatchAutomationsStateChanged() {
  window.dispatchEvent(new CustomEvent(automationsStateChangedEvent))
}
