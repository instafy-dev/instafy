// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:5173/studio"}

import { afterAll, describe, expect, it, vi } from "vitest";
import {
  isLocalProviderHostUnavailableOnThisClient,
  listLocalProviders,
} from "../localProviderHostClient";

// Local development pages are on the host's allow list, so they keep asking.
// The client binds fetch when the module loads, so replace it first.
const { fetchMock, originalFetch } = vi.hoisted(() => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, originalFetch };
});

describe("local provider host from a local development page", () => {
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("asks the provider host and reports its failure as before", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(isLocalProviderHostUnavailableOnThisClient()).toBe(false);
    await expect(listLocalProviders()).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8797/providers", undefined);
  });
});
