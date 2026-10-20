// The port rules and the loopback probe every `instafy preview` command shares.
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { PREVIEW_EXIT_PORT_NOT_ALLOWED, PreviewCommandError, noAnswerMessage, parsePreviewPort, probeLocalSite, reservedPreviewPorts } from "../src/local-site.js";

const closers: Array<() => void> = [];
afterAll(() => {
  for (const close of closers) close();
});

async function listen(server: http.Server | net.Server, host: string): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  closers.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function ipv6(): Promise<boolean> {
  const s = net.createServer();
  try {
    s.listen(0, "::1");
    await once(s, "listening");
    return true;
  } catch {
    return false;
  } finally {
    s.close();
  }
}
const hasIpv6 = await ipv6();

function exitCodeOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof PreviewCommandError ? error.exitCode : -1;
  }
}

describe("reserved preview ports", () => {
  it("refuses Instafy's default ports with no settings", () => {
    const denied = reservedPreviewPorts({});
    for (const port of [5900, 8789, 9222, 9223, 9225, 9226, 43127, 54332]) expect(denied.has(port), String(port)).toBe(true);
    expect(denied.has(4173)).toBe(false);
  });

  it("also refuses the port each Instafy setting moves a service to, and keeps the default refused", () => {
    const env = {
      INSTAFY_VNC_PORT: "5901",
      INSTAFY_PLAYWRIGHT_CDP_PORT: "9333",
      INSTAFY_PLAYWRIGHT_CDP_URL: "http://127.0.0.1:9334",
      INSTAFY_BROWSER_EGRESS_PROXY_BIND: "127.0.0.1:9336",
      ORIGIN_BIND_PORT: "54400",
      PROXY_BASE_URL: "http://host.docker.internal:18789",
      INSTAFY_PROVIDER_HOST_URL: "http://127.0.0.1:18790/",
      INSTAFY_PERSONAL_BROWSER_CONTROL_URL: "http://[::1]:43200",
    };
    const denied = reservedPreviewPorts(env);
    for (const port of [5901, 9333, 9334, 9336, 54400, 18789, 18790, 43200, 5900, 9223, 54332]) expect(denied.has(port), String(port)).toBe(true);
    for (const [name, value] of Object.entries(env)) {
      const port = Number(value.match(/(\d+)\/?$/)![1]);
      expect(exitCodeOf(() => parsePreviewPort(port, { [name]: value })), name).toBe(PREVIEW_EXIT_PORT_NOT_ALLOWED);
      expect(exitCodeOf(() => parsePreviewPort(port, {})), name).toBeNull();
    }
  });

  it("ignores an empty or unreadable Instafy setting (its default stays refused)", () => {
    const denied = reservedPreviewPorts({ INSTAFY_VNC_PORT: "", ORIGIN_BIND_PORT: "soon", PROXY_BASE_URL: "not a url" });
    expect(denied.has(5900)).toBe(true);
    expect(denied.has(54332)).toBe(true);
  });

  it("INSTAFY_PREVIEW_DENY_PORTS adds ports, and a malformed entry refuses every port", () => {
    expect(exitCodeOf(() => parsePreviewPort("4321", { INSTAFY_PREVIEW_DENY_PORTS: "4000, 4321" }))).toBe(PREVIEW_EXIT_PORT_NOT_ALLOWED);
    expect(exitCodeOf(() => parsePreviewPort("4322", { INSTAFY_PREVIEW_DENY_PORTS: "4000, 4321" }))).toBeNull();
    expect(exitCodeOf(() => parsePreviewPort("4173", { INSTAFY_PREVIEW_DENY_PORTS: "4000,43O0" }))).toBe(PREVIEW_EXIT_PORT_NOT_ALLOWED);
    // the old, unprefixed name means nothing
    expect(exitCodeOf(() => parsePreviewPort("4321", { PREVIEW_DENY_PORTS: "4321" }))).toBeNull();
  });

  it("refuses ports outside 1024-65535 and non-numbers", () => {
    for (const raw of ["80", "70000", "abc", "", "3000.5"]) expect(exitCodeOf(() => parsePreviewPort(raw, {})), raw).toBe(PREVIEW_EXIT_PORT_NOT_ALLOWED);
    expect(parsePreviewPort("4173", {})).toBe(4173);
  });
});

describe("probeLocalSite", () => {
  it("nothing on either loopback address: no host, and both addresses named", async () => {
    const port = await freePort();
    const probe = await probeLocalSite(port, "/");
    expect(probe).toMatchObject({ listening: false, status: null, host: null });
    expect(probe.reason).toMatch(/127\.0\.0\.1: ECONNREFUSED/);
    if (hasIpv6) expect(probe.reason).toMatch(/\[::1\]: ECONNREFUSED/);
    expect(probe.timedOut).toBeFalsy();
    expect(noAnswerMessage(port, probe, `port ${port}`, "retry")).toMatch(/^Nothing is answering on port \d+ \(.*\)\. Start the site first, then retry\.$/);
  });

  it("a 500 is an answer: a host and status, but not `listening` (which means below 500)", async () => {
    const port = await listen(
      http.createServer((_req, res) => {
        res.writeHead(500);
        res.end();
      }),
      "127.0.0.1",
    );
    expect(await probeLocalSite(port, "/")).toMatchObject({ listening: false, status: 500, host: "127.0.0.1" });
  });

  it("a server that accepts and never answers times out, and IPv6 is not tried after it", async () => {
    const port = await listen(
      net.createServer((socket) => closers.push(() => socket.destroy())),
      "127.0.0.1",
    );
    const probe = await probeLocalSite(port, "/", 300);
    expect(probe).toMatchObject({ listening: false, status: null, host: null });
    expect(probe.reason).toBe("127.0.0.1: no answer within 0.3 s");
    expect(probe.timedOut).toBe(true);
    expect(noAnswerMessage(port, probe, `port ${port}`, "retry")).toMatch(/accepted the connection .* still be starting or compiling: do not start a second server/);
  });

  it.skipIf(!hasIpv6)("a server on [::1] only is found there", async () => {
    const port = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      }),
      "::1",
    );
    expect(await probeLocalSite(port, "/")).toMatchObject({ listening: true, status: 200, host: "[::1]" });
  });
});
