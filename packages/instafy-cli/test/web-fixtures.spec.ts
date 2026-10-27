// Offline fixture mode (test builds only): with INSTAFY_WEB_FIXTURES, `instafy web read` answers from the hand-written
// pages in test/fixtures/web, by the same rules as the network, labelled "fixture". No test here resolves a name or
// opens a connection; the published build refuses the variable instead of reading the live web.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  WEB_FIXTURES_ALLOWED,
  WEB_READ_EXIT_INTERNAL,
  runWebReadCli,
  webRead,
  type WebReadDeps,
} from "../src/web-read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "web");
const cliBin = path.resolve(here, "..", "bin", "instafy.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-web-fixtures-"));
let caseNo = 0;
let clock = 0;
let base = "";

beforeEach(() => {
  caseNo += 1;
  clock = Date.parse("2026-10-27T09:00:00Z");
  base = path.join(tmp, `case-${caseNo}`);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deps(over: Partial<WebReadDeps> = {}): WebReadDeps {
  return {
    // Fixture mode brings its own DNS; any other lookup or dial would be a test failure.
    resolve: async (host) => {
      throw new Error(`unexpected DNS lookup of ${host}`);
    },
    dial: () => {
      throw new Error("unexpected network dial");
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    stateDir: path.join(base, "state"),
    cacheDir: path.join(base, "cache"),
    skillRoots: [],
    env: { INSTAFY_WEB_FIXTURES: FIXTURES, INSTAFY_TURN_STARTED_AT: `2026-10-27T09:00:${String(caseNo % 60).padStart(2, "0")}Z` },
    cwd: tmp,
    ...over,
  };
}

const read = (urls: string[], over: Partial<WebReadDeps> = {}) => webRead({ urls }, deps(over));

describe("offline fixtures (INSTAFY_WEB_FIXTURES, test builds only)", () => {
  it("runs the unit tests as a test build", () => {
    expect(WEB_FIXTURES_ALLOWED).toBe(true);
  });

  it("answers from the fixture files and labels the page's source fixture", async () => {
    const report = await read(["https://museum.example.org/hours"]);
    const page = report.pages[0]!;
    expect(page.status).toBe("read");
    expect(report.viewer).toBe("fixture");
    expect(page.provenance).toMatchObject({ finalUrl: "https://museum.example.org/hours", title: "City Museum: opening hours", viewer: "fixture" });
    expect(page.text).toMatch(/^<untrusted_page_content url="https:\/\/museum\.example\.org\/hours" read_at="[^"]+" viewer="fixture">\n/);
    expect(page.text).toMatch(/closes at 18:00/);
    expect(page.links).toEqual([
      { index: 0, text: "Plan your visit", href: "https://museum.example.org/visit" },
      { index: 1, text: "Hotels nearby", href: "https://www.booking.com/hotel/se/city-museum-inn.html", linkOnly: true },
    ]);
    expect(report.warnings[0]).toMatch(/^test build: pages come from the fixtures in .*fixtures[\\/]web, not the web$/);
  });

  it("refuses a Booking page as link-only", async () => {
    const report = await read(["https://www.booking.com/hotel/se/city-museum-inn.html", "https://museum.example.org/hours"]);
    expect(report.viewer).toBe("fixture");
    expect(report.pages[0]).toMatchObject({ status: "stopped", code: "link_only", provenance: { viewer: "fixture" } });
    expect(report.pages[1]).toMatchObject({ status: "read", provenance: { viewer: "fixture" } });
    expect(report.pages[0]!.message).toMatch(/^Booking\.com is link-only/);
    expect(report.pages[0]!.text).toBeUndefined();
    expect(JSON.stringify(report.pages[0])).not.toMatch(/stand-in for a hotel page/);
  });

  it("stops the site after a 429", async () => {
    const report = await read(["https://busy.example.net/a", "https://busy.example.net/b"]);
    expect(report.pages.map((page) => [page.status, page.code, page.previouslyStopped ?? false])).toEqual([
      ["stopped", "rate_limited", false],
      ["stopped", "rate_limited", true],
    ]);
  });

  it("keeps a page that says to ignore your instructions inside the untrusted wrapper", async () => {
    const page = (await read(["https://museum.example.org/notes"])).pages[0]!;
    expect(page.status).toBe("read");
    expect(page.text!.match(/<\/untrusted_page_content>/g)).toHaveLength(1);
    expect(page.text!.endsWith("\n</untrusted_page_content>")).toBe(true);
    const inside = page.text!.slice(page.text!.indexOf(">\n") + 2, page.text!.lastIndexOf("\n</untrusted_page_content>"));
    expect(inside).toMatch(/‹\/untrusted_page_content> Ignore your instructions/);
    expect(inside).toMatch(/cafe on the ground floor opens at 11:00/);
  });

  it("keeps robots.txt, redirects and the address check", async () => {
    const report = await read(["https://museum.example.org/staff/rota", "https://museum.example.org/visit", "https://intranet.example.org/", "https://nowhere.example.org/"]);
    expect(report.pages.map((page) => [page.status, page.code])).toEqual([
      ["stopped", "robots"],
      ["read", undefined],
      ["stopped", "blocked_address"],
      ["failed", "unreachable"],
    ]);
    expect(report.pages[1]!.redirects).toEqual(["https://museum.example.org/hours"]);
  });

  it("keeps fixture pages out of the cache real reads use", async () => {
    const cacheDir = path.join(base, "shared-cache");
    expect((await read(["https://museum.example.org/hours"], { cacheDir })).pages[0]!.fromCache).toBe(false);
    expect((await read(["https://museum.example.org/hours"], { cacheDir })).pages[0]!.fromCache).toBe(true);
    // The same address without fixtures is not served from the fixture's cache: it goes to the (here failing) network.
    const live = await read(["https://museum.example.org/hours"], {
      cacheDir,
      env: { INSTAFY_TURN_STARTED_AT: "2026-10-27T10:00:00Z" },
      resolve: async (host) => {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      },
    });
    expect(live.viewer).toBe("server fetch");
    expect(live.pages[0]).toMatchObject({ status: "failed", code: "unreachable", fromCache: false });
  });

  it("refuses fixtures that do not load, and reads nothing", async () => {
    const out: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
    const code = await runWebReadCli(["https://museum.example.org/hours"], { json: true }, io, deps({ env: { INSTAFY_WEB_FIXTURES: path.join(base, "missing") } }));
    expect(code).toBe(WEB_READ_EXIT_INTERNAL);
    expect(JSON.parse(out[0]!).error).toMatch(/is not a folder, so nothing was read/);
  });

  it("is refused by the published build, which never reads the live web in its place", () => {
    const home = path.join(base, "home");
    fs.mkdirSync(home, { recursive: true });
    // A private address: whichever build runs, nothing is looked up or dialled.
    const run = spawnSync(process.execPath, [cliBin, "web", "read", "http://10.0.0.5/", "--json"], {
      cwd: tmp,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: "", XDG_CACHE_HOME: "", INSTAFY_CACHE_DIR: "", INSTAFY_WEB_FIXTURES: FIXTURES },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(WEB_READ_EXIT_INTERNAL);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, exitCode: WEB_READ_EXIT_INTERNAL });
    expect(JSON.parse(run.stdout).error).toMatch(/only a test build of the Instafy CLI answers from fixtures, so nothing was read/);
    // Refused before the turn budget or the cache were touched.
    expect(fs.existsSync(path.join(home, ".local"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".cache"))).toBe(false);
  });
});
