import { afterEach, describe, expect, it } from "vitest";
import type { ConfigEnv, UserConfig } from "vite";
import { tunnelAllowedHosts } from "../../devTunnelHosts";
import viteConfig from "../../vite.config";

const previousTunnelDomain = process.env.TUNNEL_DOMAIN;

async function devServerAllowedHosts(): Promise<unknown> {
  const resolve = viteConfig as unknown as (env: ConfigEnv) => UserConfig | Promise<UserConfig>;
  const config = await resolve({ mode: "development", command: "serve" });
  return config.server?.allowedHosts;
}

describe("dev server tunnel hosts", () => {
  afterEach(() => {
    if (previousTunnelDomain === undefined) {
      delete process.env.TUNNEL_DOMAIN;
    } else {
      process.env.TUNNEL_DOMAIN = previousTunnelDomain;
    }
  });

  it("allows the configured tunnel domain and the names under it", () => {
    expect(tunnelAllowedHosts("instafy.site")).toEqual([".instafy.site"]);
    expect(tunnelAllowedHosts(" *.Instafy.Site. ")).toEqual([".instafy.site"]);
    expect(tunnelAllowedHosts(".rt.test")).toEqual([".rt.test"]);
  });

  it("adds nothing when TUNNEL_DOMAIN is unset, unreadable or a single label", () => {
    expect(tunnelAllowedHosts(undefined)).toEqual([]);
    expect(tunnelAllowedHosts("  ")).toEqual([]);
    expect(tunnelAllowedHosts("rt example")).toEqual([]);
    expect(tunnelAllowedHosts("https://instafy.site")).toEqual([]);
    expect(tunnelAllowedHosts("site")).toEqual([]);
    expect(tunnelAllowedHosts("*.site")).toEqual([]);
  });

  it("is what Studio's dev server allows, read from TUNNEL_DOMAIN", async () => {
    process.env.TUNNEL_DOMAIN = "instafy.site";
    expect(await devServerAllowedHosts()).toEqual([".instafy.site"]);
    delete process.env.TUNNEL_DOMAIN;
    expect(await devServerAllowedHosts()).toEqual([]);
  });
});
