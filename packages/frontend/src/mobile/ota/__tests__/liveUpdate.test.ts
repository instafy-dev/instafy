import { describe, expect, it } from "vitest";
import { buildNativeLiveUpdateDownloadUrl } from "../liveUpdate";

describe("buildNativeLiveUpdateDownloadUrl", () => {
  it("returns the original URL when no cache bust token is provided", () => {
    expect(
      buildNativeLiveUpdateDownloadUrl({
        bundle_id: "bundle-1",
        url: "https://downloads.instafy.dev/mobile/bundle.zip",
      }),
    ).toBe("https://downloads.instafy.dev/mobile/bundle.zip");
  });

  it("appends a cache-busting query param for clean URLs", () => {
    expect(
      buildNativeLiveUpdateDownloadUrl({
        bundle_id: "bundle-1",
        url: "https://downloads.instafy.dev/mobile/bundle.zip",
        cache_bust: "retry-1",
      }),
    ).toBe("https://downloads.instafy.dev/mobile/bundle.zip?download=retry-1");
  });

  it("preserves existing query params when adding cache busting", () => {
    expect(
      buildNativeLiveUpdateDownloadUrl({
        bundle_id: "bundle-1",
        url: "https://downloads.instafy.dev/mobile/bundle.zip?foo=bar",
        cache_bust: "retry-1",
      }),
    ).toBe("https://downloads.instafy.dev/mobile/bundle.zip?foo=bar&download=retry-1");
  });
});
