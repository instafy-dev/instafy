import { describe, expect, it } from "vitest";
import { normalizeBrowserAddress, personalBrowserAddressInput } from "../browserAddress";

// The Personal Browser's address bar: words that are not an address search with
// the person's chosen engine; addresses open as addresses.
describe("personal browser address or search", () => {
  it.each([
    ["best ramen tokyo", "best ramen tokyo"],
    ["ramen", "ramen"],
    ["  ramen near shinjuku station  ", "ramen near shinjuku station"],
    ["3.14", "3.14"],
    ["c++", "c++"],
    ["define:ramen", "define:ramen"],
    ["what is example.com", "what is example.com"],
  ])("searches for %j", (typed, query) => {
    expect(personalBrowserAddressInput(typed)).toEqual({ kind: "search", query });
  });

  it.each([
    ["example.com", "https://example.com/"],
    ["example.com/path?q=1", "https://example.com/path?q=1"],
    ["localhost:3000", "https://localhost:3000/"],
    ["localhost", "https://localhost/"],
    ["192.168.1.1", "https://192.168.1.1/"],
    ["192.168.1.1:8080/admin", "https://192.168.1.1:8080/admin"],
    ["[::1]:3000", "https://[::1]:3000/"],
    ["app.localhost", "https://app.localhost/"],
    ["http://localhost:5173", "http://localhost:5173/"],
    ["https://example.com/a b", "https://example.com/a%20b"],
    ["bücher.de", "https://xn--bcher-kva.de/"],
    ["about:blank", "about:blank"],
  ])("opens %j as an address", (typed, url) => {
    expect(personalBrowserAddressInput(typed)).toEqual({ kind: "address", url });
  });

  it.each(["", "   ", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "user:secret@example.com", "https://user:secret@example.com"])(
    "refuses %j rather than searching for it",
    (typed) => {
      expect(personalBrowserAddressInput(typed)).toEqual({ kind: "invalid" });
    },
  );

  it("leaves the Shared Browser's address rules as they were", () => {
    expect(normalizeBrowserAddress("ramen")).toBe("https://ramen/");
    expect(normalizeBrowserAddress("best ramen tokyo")).toBeNull();
  });
});
