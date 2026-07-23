export const PROVIDER_EVENT_OBSERVED_EVENT = "instafy:provider-events:observed";
export const PROVIDER_EVENT_DEBUG_INJECT_EVENT = "instafy:provider-events:inject";

function dispatchProviderEvents(eventName: string, values: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: Array.isArray(values) ? { events: values } : values,
    }),
  );
}

export function dispatchObservedProviderEvents(values: unknown) {
  dispatchProviderEvents(PROVIDER_EVENT_OBSERVED_EVENT, values);
}

export function dispatchDebugInjectedProviderEvents(values: unknown) {
  dispatchProviderEvents(PROVIDER_EVENT_DEBUG_INJECT_EVENT, values);
}
