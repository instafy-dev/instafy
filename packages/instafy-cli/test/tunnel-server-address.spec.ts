import { describe, expect, it } from "vitest";
import { resolveTunnelServerAddress } from "../dist/tunnel.js";

describe("resolveTunnelServerAddress", () => {
  it("keeps a public ingress unchanged, in or out of a container", () => {
    expect(resolveTunnelServerAddress("ingress.instafy.dev:37000", {}, true)).toBe("ingress.instafy.dev:37000");
    expect(resolveTunnelServerAddress("203.0.113.7:37000", {}, false)).toBe("203.0.113.7:37000");
  });

  it("keeps a loopback ingress on the host itself", () => {
    expect(resolveTunnelServerAddress("127.0.0.1:37000", {}, false)).toBe("127.0.0.1:37000");
  });

  it("dials the Docker host for a loopback ingress inside a container", () => {
    // A local broker advertises 127.0.0.1:37000; from a runtime container that is the container itself.
    expect(resolveTunnelServerAddress("127.0.0.1:37000", {}, true)).toBe("host.docker.internal:37000");
    expect(resolveTunnelServerAddress("localhost:37000", {}, true)).toBe("host.docker.internal:37000");
    expect(resolveTunnelServerAddress("[::1]:37000", {}, true)).toBe("host.docker.internal:37000");
  });

  it("lets INSTAFY_TUNNEL_SERVER_HOST override the host and keeps the port", () => {
    const env = { INSTAFY_TUNNEL_SERVER_HOST: "192.168.0.10" };
    expect(resolveTunnelServerAddress("127.0.0.1:37000", env, true)).toBe("192.168.0.10:37000");
    expect(resolveTunnelServerAddress("ingress.instafy.dev:37000", env, false)).toBe("192.168.0.10:37000");
  });

  it("leaves an address it cannot parse alone", () => {
    expect(resolveTunnelServerAddress("not-an-address", {}, true)).toBe("not-an-address");
  });
});
