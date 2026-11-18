import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessTokenExpiresAtMs, freshenStoredAccessToken } from "../src/controller-fetch.js";
import {
  RUNTIME_AGENT_MACHINE_LIFETIME_ENDED_EXIT_CODE,
  RUNTIME_LIFETIME_RESTART_SPACING_MS,
  decideRuntimeLifetimeRestart,
  withRemintedRuntimeToken,
} from "../src/runtime.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function jwtWith(claims: Record<string, unknown>): string {
  return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");
}

describe("a runtime whose machine lifetime ended", () => {
  it("is told apart by the exit status runtime-agent uses for it", () => {
    const agentSource = fs.readFileSync(
      path.resolve(packageRoot, "..", "runtime-agent", "src", "agent.rs"),
      "utf8",
    );
    const declared = agentSource.match(/pub const MACHINE_LIFETIME_ENDED_EXIT_CODE: i32 = (\d+);/);
    expect(declared, "runtime-agent declares MACHINE_LIFETIME_ENDED_EXIT_CODE").toBeTruthy();
    expect(Number(declared?.[1])).toBe(RUNTIME_AGENT_MACHINE_LIFETIME_ENDED_EXIT_CODE);
  });

  it("starts again only when this command minted its token, and not twice in a row", () => {
    const nowMs = 1_800_000_000_000;
    const decide = (overrides: Partial<Parameters<typeof decideRuntimeLifetimeRestart>[0]> = {}) =>
      decideRuntimeLifetimeRestart({
        exitCode: RUNTIME_AGENT_MACHINE_LIFETIME_ENDED_EXIT_CODE,
        runtimeTokenMinted: true,
        lastRestartAtMs: null,
        nowMs,
        ...overrides,
      });

    expect(decide()).toEqual({ restart: true });
    for (const exitCode of [0, 1, 3, 130, null]) {
      expect(decide({ exitCode })).toEqual({ restart: false, reason: "other_exit" });
    }
    // A runtime token the person gave is theirs to renew.
    expect(decide({ runtimeTokenMinted: false })).toEqual({
      restart: false,
      reason: "runtime_token_given",
    });
    expect(decide({ lastRestartAtMs: nowMs - RUNTIME_LIFETIME_RESTART_SPACING_MS + 1 })).toEqual({
      restart: false,
      reason: "restarted_recently",
    });
    // A clock that went backwards reads as recent, never as long ago.
    expect(decide({ lastRestartAtMs: nowMs + 60_000 })).toEqual({
      restart: false,
      reason: "restarted_recently",
    });
    expect(decide({ lastRestartAtMs: nowMs - RUNTIME_LIFETIME_RESTART_SPACING_MS })).toEqual({
      restart: true,
    });
  });

  it("gets the new token wherever the old one was, and keeps an origin token given apart", () => {
    const env = {
      PATH: "/bin",
      RUNTIME_ACCESS_TOKEN: "old-machine-token",
      ORIGIN_ACCESS_TOKEN: "old-machine-token",
      ORIGIN_INTERNAL_TOKEN: "old-machine-token",
    };
    expect(withRemintedRuntimeToken(env, "old-machine-token", "new-machine-token")).toEqual({
      PATH: "/bin",
      RUNTIME_ACCESS_TOKEN: "new-machine-token",
      ORIGIN_ACCESS_TOKEN: "new-machine-token",
      ORIGIN_INTERNAL_TOKEN: "new-machine-token",
    });
    expect(env.RUNTIME_ACCESS_TOKEN).toBe("old-machine-token");

    const givenOrigin = { ...env, ORIGIN_ACCESS_TOKEN: "given-origin-token" };
    expect(
      withRemintedRuntimeToken(givenOrigin, "old-machine-token", "new-machine-token"),
    ).toMatchObject({
      RUNTIME_ACCESS_TOKEN: "new-machine-token",
      ORIGIN_ACCESS_TOKEN: "given-origin-token",
      ORIGIN_INTERNAL_TOKEN: "new-machine-token",
    });
    // Without a token to match, only the runtime token is set.
    expect(withRemintedRuntimeToken({ ORIGIN_ACCESS_TOKEN: "" }, "", "new-machine-token")).toEqual({
      ORIGIN_ACCESS_TOKEN: "",
      RUNTIME_ACCESS_TOKEN: "new-machine-token",
    });
  });
});

describe("a session a runtime token is minted from", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.INSTAFY_PROFILE;
  const homes: string[] = [];

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedProfile === undefined) {
      delete process.env.INSTAFY_PROFILE;
    } else {
      process.env.INSTAFY_PROFILE = savedProfile;
    }
    for (const home of homes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  it("reads the expiry an access token carries", () => {
    expect(accessTokenExpiresAtMs(jwtWith({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    for (const token of [
      jwtWith({ sub: "person" }),
      jwtWith({ exp: "soon" }),
      "not-a-jwt",
      "header.%%%.signature",
      ["header", Buffer.from("null").toString("base64url"), "signature"].join("."),
    ]) {
      expect(accessTokenExpiresAtMs(token)).toBeNull();
    }
  });

  it("is refreshed only when it is the saved one and about to end", async () => {
    const nowMs = 1_800_000_000_000;
    const ending = jwtWith({ exp: nowMs / 1000 + 60 });
    const lasting = jwtWith({ exp: nowMs / 1000 + 3600 });
    const margin = 15 * 60 * 1000;
    // None of these reads the saved session or reaches a network.
    for (const tokenSource of ["explicit", "env", "none"] as const) {
      await expect(
        freshenStoredAccessToken({
          url: "http://127.0.0.1:9/",
          accessToken: ending,
          tokenSource,
          marginMs: margin,
          nowMs,
        }),
      ).resolves.toBe(ending);
    }
    for (const accessToken of [lasting, "opaque-token"]) {
      await expect(
        freshenStoredAccessToken({
          url: "http://127.0.0.1:9/",
          accessToken,
          tokenSource: "config",
          marginMs: margin,
          nowMs,
        }),
      ).resolves.toBe(accessToken);
    }
  });

  it("refreshes a saved session about to end, and saves what it got", async () => {
    const nowMs = Date.now();
    const ending = jwtWith({ exp: Math.floor(nowMs / 1000) + 60 });
    const refreshed = jwtWith({ exp: Math.floor(nowMs / 1000) + 3600 });
    const refreshBodies: unknown[] = [];
    const supabase = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/auth/v1/token?grant_type=refresh_token") {
          refreshBodies.push(JSON.parse(body));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: refreshed, refresh_token: "refresh-2" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    supabase.listen(0, "127.0.0.1");
    await once(supabase, "listening");
    const address = supabase.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // The CLI reads its saved session under HOME: a home of the test's own.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-home-"));
    homes.push(home);
    fs.mkdirSync(path.join(home, ".instafy"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".instafy", "config.json"),
      JSON.stringify({
        controllerUrl: "http://127.0.0.1:8788",
        accessToken: ending,
        refreshToken: "refresh-1",
        supabaseUrl: `http://127.0.0.1:${port}`,
        supabaseAnonKey: "anon-key",
      }),
    );
    process.env.HOME = home;
    delete process.env.INSTAFY_PROFILE;
    vi.resetModules();
    try {
      const fetchModule = await import("../src/controller-fetch.js");
      const freshened = await fetchModule.freshenStoredAccessToken({
        url: "http://127.0.0.1:8788",
        accessToken: ending,
        tokenSource: "config",
        cwd: home,
        marginMs: 15 * 60 * 1000,
        nowMs,
      });
      expect(freshened).toBe(refreshed);
      expect(refreshBodies).toEqual([{ refresh_token: "refresh-1" }]);
      const saved = JSON.parse(fs.readFileSync(path.join(home, ".instafy", "config.json"), "utf8"));
      expect(saved).toMatchObject({ accessToken: refreshed, refreshToken: "refresh-2" });

      // A saved session for another controller is never sent there.
      await expect(
        fetchModule.freshenStoredAccessToken({
          url: "http://127.0.0.1:9999",
          accessToken: refreshed,
          tokenSource: "config",
          cwd: home,
          marginMs: 2 * 60 * 60 * 1000,
          nowMs,
        }),
      ).rejects.toThrow(/different controller origin/);
      expect(refreshBodies).toHaveLength(1);
    } finally {
      supabase.close();
    }
  });
});
