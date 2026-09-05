let signalAppMounted: () => void;
const appMounted = new Promise<void>((resolve) => {
  signalAppMounted = resolve;
});

/** One successful shell commit releases OTA startup for this document, including StrictMode. */
export function markNativeOtaAppMounted(): void {
  signalAppMounted();
}

export function waitForNativeOtaAppMounted(): Promise<void> {
  return appMounted;
}
