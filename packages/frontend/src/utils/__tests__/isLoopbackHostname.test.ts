import { describe, expect, it } from "vitest";

import { isLoopbackHostname } from "../isLoopbackHostname";

describe("isLoopbackHostname", () => {
  it("counts this machine's names and addresses", () => {
    for (const hostname of ["localhost", "LOCALHOST", " localhost ", "127.0.0.1", "::1", "[::1]"]) {
      expect(isLoopbackHostname(hostname), hostname).toBe(true);
    }
  });

  it("counts an IPv6 loopback address as a URL writes it", () => {
    // URL.hostname keeps the brackets: "[::1]", never "::1".
    expect(new URL("http://[::1]:8796/health").hostname).toBe("[::1]");
    expect(isLoopbackHostname(new URL("http://[::1]:8796/health").hostname)).toBe(true);
  });

  it("counts no other host", () => {
    for (const hostname of [
      "",
      "example.com",
      "localhost.example.com",
      "127.0.0.1.example.com",
      "192.168.1.20",
      "[::2]",
      "[fe80::1]",
    ]) {
      expect(isLoopbackHostname(hostname), hostname).toBe(false);
    }
  });
});
