// All page traffic stays on a local fixture server. The controller double models atomic reservations so separate
// readers must coordinate through that API even when their turn IDs and local state folders differ.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchBudgetError, sharedResearchBudget, type ResearchBudget } from "../src/web-budget.js";
import { formatWebRead, registerWebCommand, runWebBudgetCli, runWebReadCli, webBudget, webRead, type WebReadDeps } from "../src/web-read.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-web-budget-"));
const token = "research-test-only";
const env = {
  INSTAFY_RESEARCH_SHARED: "1",
  INSTAFY_RESEARCH_CONTROLLER_URL: "https://controller.example",
  INSTAFY_RESEARCH_ACCESS_TOKEN: token,
};
let server: http.Server;
let port: number;
let clock: number;
let caseDir: string;
let hits: string[];
let pageHeaders: http.IncomingHttpHeaders[];
let routes: Record<string, { status?: number; body?: string; location?: string; elapsedMs?: number }>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const key = `${req.headers.host}${req.url}`;
    hits.push(key);
    pageHeaders.push(req.headers);
    const route = routes[key];
    clock += route?.elapsedMs ?? 0;
    res.writeHead(route?.status ?? (!route && req.url === "/robots.txt" ? 404 : 200), {
      "content-type": "text/plain",
      ...(route?.location ? { location: route.location } : {}),
    });
    res.end(route?.body ?? "The museum opens at ten every morning.");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  clock = Date.parse("2026-10-28T10:00:00Z");
  caseDir = path.join(root, randomUUID());
  hits = [];
  pageHeaders = [];
  routes = {};
});

type Reservation = { loadId: string; requestId: string; host: string; remainingMs: number };

function controller(total = 12, perSite = 4) {
  const state: ResearchBudget = {
    scope: "this task", loadsUsed: 0, loadsLeft: total, loadsPerTurn: total, loadsPerHost: perSite,
    hostSpacingSeconds: 2, hosts: {},
  };
  const loads = new Map<string, Set<string>>();
  const reserved = new Map<string, number>();
  const posts: Reservation[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    expect(String(input)).toBe("https://controller.example/agent/research-budget");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe("error");
    if (init?.method !== "POST") return Response.json({ budget: state });
    const body: Reservation = JSON.parse(String(init.body));
    posts.push(body);
    const previous = reserved.get(body.requestId);
    if (previous !== undefined) return Response.json({ allowed: true, waitMs: Math.max(0, previous - clock), budget: state });
    const sites = loads.get(body.loadId);
    let code: "turn_limit" | "host_limit" | "time_limit" | undefined;
    const host = state.hosts[body.host];
    const at = Math.max(clock, (host?.lastAt ?? 0) + 2_000);
    if (!sites && state.loadsLeft === 0) code = "turn_limit";
    else if (!sites?.has(body.host) && (host?.loads ?? 0) >= state.loadsPerHost) code = "host_limit";
    else if (at - clock > body.remainingMs) code = "time_limit";
    if (code) return Response.json({ allowed: false, code, waitMs: 0, budget: state });
    if (!sites) { state.loadsUsed += 1; state.loadsLeft -= 1; loads.set(body.loadId, new Set()); }
    state.hosts[body.host] = { loads: (host?.loads ?? 0) + (sites?.has(body.host) ? 0 : 1), lastAt: at };
    loads.get(body.loadId)!.add(body.host);
    reserved.set(body.requestId, at);
    return Response.json({ allowed: true, waitMs: at - clock, budget: state });
  });
  return { state, posts, requests, fetcher: fetcher as typeof fetch & typeof fetcher };
}

function deps(budgetFetch: typeof fetch, worker = "lead"): WebReadDeps {
  return {
    env: { ...env, INSTAFY_TURN_STARTED_AT: worker, INSTAFY_PROJECT_ID: "test-project" },
    budgetFetch,
    stateDir: path.join(caseDir, worker, "state"),
    cacheDir: path.join(caseDir, worker, "cache"),
    skillRoots: [],
    cwd: caseDir,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => ({ host: "127.0.0.1", port }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
}

describe("shared research allowance", () => {
  it("shares the total across concurrent helpers with different local state and turn IDs", async () => {
    const c = controller(2, 2);
    const reports = await Promise.all(["lead", "child-one", "child-two", "team-worker"].map((worker, i) =>
      webRead({ urls: [`http://site${i}.example/article`] }, deps(c.fetcher, worker))));
    expect(reports.flatMap((report) => report.pages).filter((page) => page.status === "read")).toHaveLength(2);
    expect(reports.flatMap((report) => report.pages).filter((page) => page.code === "turn_limit")).toHaveLength(2);
    expect(c.state.loadsUsed).toBe(2);
    expect(hits.filter((hit) => hit.endsWith("/article"))).toHaveLength(2);
    expect((await webBudget(deps(c.fetcher))).budget).toMatchObject({ scope: "this task", loadsUsed: 2, loadsLeft: 0 });
  });

  it("shares each site's allowance and normalizes www and trailing dots", async () => {
    const c = controller(4, 1);
    const reports = await Promise.all([
      webRead({ urls: ["http://www.news.example/one"] }, deps(c.fetcher, "lead")),
      webRead({ urls: ["http://news.example./two"] }, deps(c.fetcher, "helper")),
    ]);
    expect(reports.flatMap((report) => report.pages).map((page) => page.status).sort()).toEqual(["read", "skipped"]);
    expect(reports.flatMap((report) => report.pages).find((page) => page.code === "host_limit")?.tell).toContain("1 page loads");
    expect(c.state.hosts["news.example"].loads).toBe(1);
    expect(c.posts.every((post) => post.host === "news.example")).toBe(true);
  });

  it("paces every redirect hop and charges a load and each visited site once", async () => {
    const c = controller(8, 4);
    routes["news.example/start"] = { status: 302, location: "/middle" };
    routes["news.example/middle"] = { status: 302, location: "http://other.example/final" };
    const before = clock;
    const report = await webRead({ urls: ["http://news.example/start"] }, deps(c.fetcher));
    expect(report.pages[0].status).toBe("read");
    expect(clock - before).toBe(2_000);
    expect(c.posts).toHaveLength(3);
    expect(new Set(c.posts.map((post) => post.loadId)).size).toBe(1);
    expect(new Set(c.posts.map((post) => post.requestId)).size).toBe(3);
    expect(report.budget).toMatchObject({ loadsUsed: 1, loadsLeft: 7, hosts: { "news.example": 1, "other.example": 1 } });
    expect(pageHeaders.every((headers) => headers.authorization === undefined)).toBe(true);
  });

  it("does not spend an allowance on cache hits, even when the shared total is exhausted", async () => {
    const c = controller(1, 1);
    await webRead({ urls: ["http://news.example/article"] }, deps(c.fetcher));
    const priorHits = hits.length;
    const cached = await webRead({ urls: ["http://news.example/article"] }, deps(c.fetcher));
    expect(cached.pages[0]).toMatchObject({ status: "read", fromCache: true });
    expect(cached.budget).toMatchObject({ loadsUsed: 1, loadsLeft: 0 });
    expect(hits).toHaveLength(priorHits);
    expect(c.posts).toHaveLength(1);
    const fresh = await webRead({ urls: ["http://news.example/article"], fresh: true }, deps(c.fetcher));
    expect(fresh.pages[0]).toMatchObject({ code: "turn_limit" });
    expect(hits).toHaveLength(priorHits);
  });

  it("keeps the six-hop ceiling while pacing redirects back to the same site", async () => {
    const c = controller();
    for (let hop = 0; hop < 7; hop += 1) routes[`news.example/${hop}`] = { status: 302, location: `/${hop + 1}` };
    const report = await webRead({ urls: ["http://news.example/0"] }, deps(c.fetcher));
    expect(report.pages[0]).toMatchObject({ status: "stopped", code: "redirects" });
    expect(c.posts).toHaveLength(6);
    expect(report.budget).toMatchObject({ loadsUsed: 1, hosts: { "news.example": 1 } });
    expect(hits).not.toContain("news.example/6");
  });

  it("does not spend another load when shared pacing leaves no time in this call", async () => {
    const c = controller();
    c.state.loadsUsed = 1;
    c.state.loadsLeft = 11;
    c.state.hosts["news.example"] = { loads: 1, lastAt: clock + 60_000 };
    const report = await webRead({ urls: ["http://news.example/queued"] }, deps(c.fetcher));
    expect(report.pages[0]).toMatchObject({ status: "skipped", code: "time_limit" });
    expect(c.state.loadsUsed).toBe(1);
    expect(c.posts[0].remainingMs).toBe(59_000);
    expect(hits).toEqual(["news.example/robots.txt"]);
  });

  it("keeps robots, private-address and remembered site stops ahead of the charge", async () => {
    const c = controller();
    routes["news.example/robots.txt"] = { body: "User-agent: *\nDisallow: /private" };
    expect((await webRead({ urls: ["http://news.example/private"] }, deps(c.fetcher))).pages[0].code).toBe("robots");
    const privateDeps = { ...deps(c.fetcher), resolve: async () => [{ address: "10.0.0.1", family: 4 }] };
    expect((await webRead({ urls: ["http://private.example/page"] }, privateDeps)).pages[0].code).toBe("blocked_address");
    expect(c.posts).toHaveLength(0);
    routes["busy.example/page"] = { status: 429 };
    expect((await webRead({ urls: ["http://busy.example/page"] }, deps(c.fetcher))).pages[0].code).toBe("rate_limited");
    const hitCount = hits.length;
    expect((await webRead({ urls: ["http://busy.example/next"], fresh: true }, deps(c.fetcher))).pages[0]).toMatchObject({ code: "rate_limited", previouslyStopped: true });
    expect(c.posts).toHaveLength(1);
    expect(hits).toHaveLength(hitCount);
  });

  it("reports a larger configured budget without applying standalone caps", async () => {
    const c = controller(20, 8);
    const report = await webRead({ urls: Array.from({ length: 6 }, (_, i) => `http://news.example/${i}`) }, deps(c.fetcher));
    expect(report.pages.every((page) => page.status === "read")).toBe(true);
    expect(report.budget).toMatchObject({ loadsUsed: 6, loadsPerTurn: 20, loadsPerHost: 8, loadsLeft: 14 });
  });

  it("retains collected pages at the call deadline and marks the last validated shared count", async () => {
    const c = controller();
    routes["news.example/slow"] = { elapsedMs: 60_000 };
    const report = await webRead({ urls: ["http://news.example/slow", "http://news.example/next"] }, deps(c.fetcher));
    expect(report.pages[0]).toMatchObject({ status: "read", fromCache: false });
    expect(report.pages[0].text).toContain("The museum opens at ten");
    expect(report.pages[1]).toMatchObject({ status: "skipped", code: "time_limit" });
    expect(report.budget).toMatchObject({ scope: "this task", loadsUsed: 1, loadsLeft: 11, lastKnown: true });
    expect(report.warnings).toContainEqual(expect.stringContaining("last validated controller snapshot"));
    expect(formatWebRead(report)).toContain("Last known controller count: 1 of 12");
    expect(c.requests.filter(({ init }) => init?.method === "GET")).toHaveLength(1);
    const priorHits = hits.length;
    const unavailable = vi.fn(async () => { throw new Error("controller offline"); });
    await expect(webRead({ urls: ["http://news.example/slow"], fresh: true }, deps(unavailable as typeof fetch))).rejects.toBeInstanceOf(ResearchBudgetError);
    expect(unavailable).toHaveBeenCalled();
    expect(hits).toHaveLength(priorHits);
  });

  it("retains pages if the final refresh fails while time remains, but never invents an initial count", async () => {
    const c = controller();
    let statusCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === "GET" && ++statusCalls > 1) return new Response("unavailable", { status: 503 });
      return c.fetcher(input, init);
    };
    const report = await webRead({ urls: ["http://news.example/page"] }, deps(fetcher));
    expect(report.pages[0].status).toBe("read");
    expect(report.budget).toMatchObject({ loadsUsed: 1, loadsLeft: 11, lastKnown: true });
    expect(report.warnings).toHaveLength(1);
    // A different call has no validated snapshot to report, even if it can find the page in the cache.
    await expect(webRead({ urls: ["http://news.example/page"] }, deps(fetcher))).rejects.toBeInstanceOf(ResearchBudgetError);
  });

  it.each(["status", "reservation", "lost reservation response"])("retains earlier evidence when a later %s fails and stops remaining reads", async (failure) => {
    const c = controller();
    let gets = 0;
    let posts = 0;
    let offline = false;
    const fetcher: typeof fetch = async (input, init) => {
      if (offline) return new Response("private controller diagnostics", { status: 503 });
      if (init?.method === "GET" && ++gets > 1 && failure === "status") {
        return new Response("private controller diagnostics", { status: 503 });
      }
      if (init?.method === "POST" && ++posts > 1 && failure !== "status") {
        if (failure === "lost reservation response") {
          await c.fetcher(input, init);
          throw new Error("private transport diagnostics");
        }
        return new Response("private controller diagnostics", { status: 503 });
      }
      return c.fetcher(input, init);
    };
    const out: string[] = [];
    const exitCode = await runWebReadCli(
      ["http://news.example/one", "http://news.example/two", "http://news.example/three"], { json: true },
      { out: (line) => out.push(line), err: () => {} }, deps(fetcher),
    );
    expect(exitCode).toBe(0);
    const report = JSON.parse(out[0]);
    expect(report.pages[0]).toMatchObject({ status: "read", fromCache: false, provenance: { finalUrl: "http://news.example/one" } });
    expect(report.pages[0].text).toContain("The museum opens at ten");
    expect(report.pages.slice(1)).toMatchObject([
      { status: "failed", code: "budget_unavailable" }, { status: "failed", code: "budget_unavailable" },
    ]);
    expect(report.budget).toMatchObject({ scope: "this task", loadsUsed: 1, lastKnown: true });
    expect(report.warnings).toContainEqual(expect.stringContaining("last validated controller snapshot"));
    expect(out.join("")).not.toContain("private");
    expect(hits.filter((hit) => !hit.endsWith("/robots.txt"))).toEqual(["news.example/one"]);
    // A lost response may have spent the second reservation; the last known count is not a refund.
    expect(c.state.loadsUsed).toBe(failure === "lost reservation response" ? 2 : 1);
    offline = true;
    const priorHits = hits.length;
    await expect(webRead({ urls: ["http://news.example/three"] }, deps(fetcher))).rejects.toBeInstanceOf(ResearchBudgetError);
    expect(hits).toHaveLength(priorHits);
  });

  it("fails closed on controller denial, bad responses and transport failures without reaching a page", async () => {
    for (const fetcher of [
      vi.fn(async () => new Response("private diagnostics", { status: 401 })),
      vi.fn(async () => Response.json({ budget: { loadsLeft: 99 } })),
      vi.fn(async () => { throw new Error("credential-shaped transport details"); }),
    ]) {
      const out: string[] = [];
      expect(await runWebReadCli(["http://news.example/page"], { json: true }, { out: (line) => out.push(line), err: () => {} }, deps(fetcher as typeof fetch))).toBe(70);
      expect(JSON.parse(out[0])).toMatchObject({ ok: false, exitCode: 70 });
      expect(out.join("")).not.toMatch(/private diagnostics|credential-shaped/);
      expect(hits).toEqual([]);
    }
  });

  it("fails closed after a lost reservation response and never fetches the page", async () => {
    const c = controller();
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === "POST") throw new Error("offline");
      return c.fetcher(input, init);
    };
    await expect(webRead({ urls: ["http://news.example/page"] }, deps(fetcher))).rejects.toBeInstanceOf(ResearchBudgetError);
    expect(hits).toEqual(["news.example/robots.txt"]);
  });
});

describe("research allowance binding and status", () => {
  it("retries a lost response with the same load and hop ID without spending twice", async () => {
    const c = controller();
    let lost = false;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await c.fetcher(input, init);
      if (init?.method === "POST" && !lost) { lost = true; throw new Error("response lost after commit"); }
      return response;
    };
    const client = sharedResearchBudget(env, fetcher)!;
    expect(await client.reserve(randomUUID(), randomUUID(), "news.example", 30_000)).toMatchObject({ allowed: true });
    expect(c.posts).toHaveLength(2);
    expect(c.posts[0]).toEqual(c.posts[1]);
    expect(c.state.loadsUsed).toBe(1);
  });

  it("never falls back locally when any shared binding is missing or malformed", async () => {
    for (const broken of [
      { INSTAFY_RESEARCH_SHARED: "1" },
      { INSTAFY_RESEARCH_ACCESS_TOKEN: token },
      { ...env, INSTAFY_RESEARCH_SHARED: "0" },
      { ...env, INSTAFY_RESEARCH_CONTROLLER_URL: "https://controller.example/path" },
      { ...env, INSTAFY_RESEARCH_CONTROLLER_URL: "https://user:secret@controller.example" },
      { ...env, INSTAFY_RESEARCH_CONTROLLER_URL: "file:///tmp/controller" },
    ]) {
      expect(() => sharedResearchBudget(broken)).toThrow(ResearchBudgetError);
      await expect(webRead({ urls: ["http://news.example/page"] }, { ...deps(vi.fn()), env: broken })).rejects.toBeInstanceOf(ResearchBudgetError);
    }
    expect(sharedResearchBudget({})).toBeNull();
    expect(hits).toEqual([]);
  });

  it("uses only the granted origin and research credential, regardless of user server or login settings", async () => {
    const c = controller();
    await webBudget({ ...deps(c.fetcher), env: { ...env, INSTAFY_SERVER_URL: "https://untrusted.example", INSTAFY_ACCESS_TOKEN: "different-user-token" } });
    expect(c.requests).toHaveLength(1);
    expect(c.posts).toHaveLength(0);
  });

  it("does not follow a controller redirect or forward its credential to the destination", async () => {
    const requests: string[] = [];
    const redirectServer = http.createServer((req, res) => {
      requests.push(req.url!);
      res.writeHead(302, { location: "/unexpected" });
      res.end();
    });
    redirectServer.listen(0, "127.0.0.1");
    await once(redirectServer, "listening");
    try {
      const origin = `http://127.0.0.1:${(redirectServer.address() as AddressInfo).port}`;
      await expect(sharedResearchBudget({ ...env, INSTAFY_RESEARCH_CONTROLLER_URL: origin })!.status()).rejects.toBeInstanceOf(ResearchBudgetError);
      expect(requests.every((url) => url === "/agent/research-budget")).toBe(true);
      expect(requests).toHaveLength(2);
    } finally {
      await new Promise((resolve) => redirectServer.close(resolve));
    }
  });

  it("exposes status as JSON without reserving, and keeps standalone status compatible", async () => {
    const c = controller(16, 5);
    const out: string[] = [];
    expect(await runWebBudgetCli({ json: true }, { out: (line) => out.push(line), err: () => {} }, deps(c.fetcher))).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ budget: { scope: "this task", loadsUsed: 0, loadsLeft: 16, loadsPerHost: 5 } });
    expect(c.posts).toHaveLength(0);
    const standalone = await webBudget({ ...deps(c.fetcher), env: {} });
    expect(standalone.budget).toMatchObject({ loadsUsed: 0, loadsLeft: 12, loadsPerTurn: 12, loadsPerHost: 4 });
    expect(standalone.budget.scope).toContain("this session");
    const web = registerWebCommand(new Command());
    expect(web.commands.find((command) => command.name() === "budget")?.options.map((option) => option.long)).toEqual(["--json"]);
  });
});
