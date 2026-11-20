import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { confirm } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMachineRecords, runtimeMachines, runtimeRevoke, type MachineRecord } from "../src/machines.js";

// At a terminal, revoke asks with @clack/prompts' confirm; a symbol is a cancelled question.
vi.mock("@clack/prompts", () => ({ confirm: vi.fn(), isCancel: (value: unknown) => typeof value === "symbol" }));

const TOKEN = "person-session-token";
const DESK = "3f2a91c4-1111-4111-8111-111111111111";
const BROWSER = "3f2a91c5-2222-4222-8222-222222222222";
const PENDING = "9b7e0d21-3333-4333-8333-333333333333";
const OLD = "5c1d2e3f-4444-4444-8444-444444444444";
const LOOSE = "7a8b9c0d-6666-4666-8666-666666666666";
const HOSTILE = "3f2a91c6-5555-4555-8555-555555555555";
const GONE = "8d9e0f1a-7777-4777-8777-777777777777";

const listed = [
  {
    runtimeId: DESK,
    projectId: "space-a",
    projectReadable: true,
    projectName: "Garden plans",
    displayName: "Studio Mac",
    provider: "self-hosted",
    status: "ready",
    lastSeenAt: "2026-11-18T12:00:00Z",
    mintedAt: null,
    personalBrowser: false,
    revoked: false,
    revokedAt: null,
    capabilities: { secret: "never printed" },
  },
  // As a server from before revocation was listed answers: no revoked fields.
  {
    runtimeId: BROWSER,
    projectId: "space-b",
    projectReadable: false,
    projectName: "Renamed after you left",
    displayName: null,
    provider: "self-hosted",
    status: "offline",
    lastSeenAt: null,
    mintedAt: null,
    personalBrowser: true,
  },
  {
    runtimeId: PENDING,
    projectId: "space-a",
    projectReadable: true,
    projectName: null,
    displayName: null,
    provider: null,
    status: "pending",
    lastSeenAt: null,
    mintedAt: "2026-11-18T11:00:00Z",
    personalBrowser: false,
    revoked: false,
    revokedAt: null,
  },
  {
    runtimeId: OLD,
    projectId: "space-c",
    projectReadable: true,
    projectName: "Shared lab",
    displayName: "Old laptop",
    provider: "self-hosted",
    status: "stopped",
    lastSeenAt: "2026-11-17T09:00:00Z",
    mintedAt: null,
    personalBrowser: false,
    revoked: true,
    revokedAt: "2026-11-18T10:00:00Z",
  },
];

// A second machine you revoked, in another space.
const gone = {
  ...listed[3],
  runtimeId: GONE,
  projectId: "space-e",
  projectName: "Night builds",
  displayName: "Build box",
  revokedAt: "2026-11-18T10:30:00Z",
};

// Every bidirectional mark a terminal may reorder the text after it by.
const BIDI_MARKS = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
// A machine names itself each time it registers, and a teammate may rename a shared space. This one
// tries to erase its row, write over a short id from the start of the line or the line above, set
// the window title, hide or reorder text and write to the clipboard, with C0 and C1 controls alike.
const hostile = {
  runtimeId: HOSTILE,
  projectId: "space-d",
  projectReadable: true,
  projectName: `Shared\u001b]52;c;aGk=\u0007 lab\u009b2J\u2028\u2029${BIDI_MARKS}`,
  displayName: "Lost\u001b[2K laptop\r3f2a91c4\u009b1A\u009d0;Studio Mac\u009c\u007f",
  provider: "self-hosted",
  status: "ready\u001b[8m",
  lastSeenAt: "yesterday\r",
  mintedAt: null,
  personalBrowser: false,
};
const HOSTILE_NAME = String.raw`Lost\u001b[2K laptop\u000d3f2a91c4\u009b1A\u009d0;Studio Mac\u009c\u007f`;
const HOSTILE_SPACE =
  String.raw`Shared\u001b]52;c;aGk=\u0007 lab\u009b2J\u2028\u2029` +
  String.raw`\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069`;
// What the hostile text would have a terminal act on, were it printed as it came: its C0 control
// sequences, and any DEL, C1 control, line or paragraph separator or bidirectional mark, which
// `JSON.stringify` alone would print as they came.
const RAW_CONTROLS = ["\u001b[2K", "\u001b]52", "\u0007", "\u001b[8m", "\r"];
const RAW_BEYOND_C0 = /[\u007f\u0080-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const unescaped = (text: string) => [
  ...RAW_CONTROLS.filter((control) => text.includes(control)),
  ...(text.match(RAW_BEYOND_C0) ?? []),
];

const ask = vi.mocked(confirm);
const ttyDescriptors = [process.stdin, process.stdout].map((stream) =>
  Object.getOwnPropertyDescriptor(stream, "isTTY"),
);

/** Run with stdin and stdout each a terminal or not, and outside CI either way. */
function setTerminal(stdin: boolean, stdout = stdin) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdout });
  vi.stubEnv("CI", "false");
}

type Recorded = { method: string; path: string; authorization: string | undefined; body: unknown };

describe("your machines in the CLI", () => {
  let server: http.Server;
  let url: string;
  let requests: Recorded[];
  let listing: unknown[];
  let revokeAnswer: Record<string, unknown>;
  let output: string[];

  beforeEach(async () => {
    requests = [];
    output = [];
    listing = listed;
    revokeAnswer = { revoked: [DESK], pendingEnded: [] };
    ask.mockReset();
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      output.push(values.map(String).join(" "));
    });
    server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization,
          body: raw ? JSON.parse(raw) : null,
        });
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${TOKEN}`) {
          response.statusCode = 401;
          response.end(JSON.stringify({ message: "interactive user session required" }));
        } else if (request.method === "GET" && request.url === "/me/runtimes") {
          response.end(JSON.stringify({ runtimes: listing }));
        } else if (request.method === "POST" && request.url === "/me/runtimes/revoke") {
          response.end(JSON.stringify(revokeAnswer));
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "not found" }));
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    [process.stdin, process.stdout].forEach((stream, index) => {
      const descriptor = ttyDescriptors[index];
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
      else delete (stream as { isTTY?: boolean }).isTTY;
    });
    server.close();
    await once(server, "close");
  });

  const auth = () => ({ controllerUrl: url, accessToken: TOKEN });
  const said = () => output.join("\n");
  const posts = () => requests.filter((request) => request.method === "POST");

  it("lists your machines as JSON with only the fields it knows", async () => {
    // `revoked` counts only when it is exactly true, and `revokedAt` only while it does.
    listing = [...listed, { ...listed[0], runtimeId: LOOSE, revoked: "true", revokedAt: "2026-11-18T10:00:00Z" }];
    await runtimeMachines({ ...auth(), json: true });
    expect(requests).toEqual([{ method: "GET", path: "/me/runtimes", authorization: `Bearer ${TOKEN}`, body: null }]);
    const printed = JSON.parse(said()) as MachineRecord[];
    expect(printed.map((record) => record.runtimeId)).toEqual([DESK, BROWSER, PENDING, OLD, LOOSE]);
    expect(printed[0]).toEqual({
      runtimeId: DESK,
      projectId: "space-a",
      projectReadable: true,
      projectName: "Garden plans",
      displayName: "Studio Mac",
      provider: "self-hosted",
      status: "ready",
      lastSeenAt: "2026-11-18T12:00:00Z",
      mintedAt: null,
      personalBrowser: false,
      revoked: false,
      revokedAt: null,
    });
    expect(printed[1]).toMatchObject({ projectName: null, revoked: false, revokedAt: null });
    expect(printed[3]).toMatchObject({ runtimeId: OLD, revoked: true, revokedAt: "2026-11-18T10:00:00Z" });
    expect(printed[4]).toMatchObject({ runtimeId: LOOSE, revoked: false, revokedAt: null });
    expect(said()).not.toContain("never printed");
  });

  it("lists your machines as a table", async () => {
    await runtimeMachines(auth());
    const table = said();
    expect(table).toMatch(/3f2a91c4\s+Studio Mac\s+Garden plans\s+ready\s+2026-11-18 12:00Z/);
    expect(table).toMatch(/3f2a91c5\s+Personal Browser\s+\(a space you can no longer open\)\s+offline\s+never/);
    expect(table).toMatch(/9b7e0d21\s+New machine\s+Untitled space\s+not connected yet\s+minted 2026-11-18 11:00Z/);
    expect(table).toMatch(/5c1d2e3f\s+Old laptop\s+Shared lab\s+revoked\s+2026-11-17 09:00Z/);
    expect(table).not.toContain("Renamed after you left");
  });

  it("escapes the text a machine or a teammate chose wherever it is printed", async () => {
    listing = [listed[0], hostile];
    await runtimeMachines(auth());
    const row = said().split("\n").find((line) => line.startsWith("3f2a91c6"));
    expect(row).toContain(HOSTILE_NAME);
    expect(row).toContain(HOSTILE_SPACE);
    expect(row).toContain(String.raw`ready\u001b[8m`);
    expect(row).toContain(String.raw`yesterday\u000d`);
    expect(unescaped(said())).toEqual([]);

    const refusal = await runtimeRevoke({ ...auth(), idsOrPrefixes: ["3f2a91c"], yes: true }).then(
      () => "revoked",
      (error: unknown) => String(error),
    );
    expect(refusal).toContain("ambiguous; it matches 2 machines");
    expect(refusal).toContain(`  3f2a91c6 · ${HOSTILE_NAME} · ${HOSTILE_SPACE}`);
    expect(unescaped(refusal)).toEqual([]);

    setTerminal(true);
    output.length = 0;
    ask.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [HOSTILE] })).rejects.toThrow("Cancelled.");
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true })).rejects.toThrow("Cancelled.");
    const details = output.filter((line) => line.includes(`(${HOSTILE})`));
    expect(details).toEqual([
      expect.stringContaining(`  3f2a91c6 · ${HOSTILE_NAME} · ${HOSTILE_SPACE} (${HOSTILE})`),
      expect.stringContaining(`  3f2a91c6 · ${HOSTILE_NAME} · ${HOSTILE_SPACE} (${HOSTILE})`),
    ]);
    expect(unescaped(said())).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("prints that text with --json as escapes, which parse back to the text as it came", async () => {
    listing = [listed[0], hostile];
    await runtimeMachines({ ...auth(), json: true });
    expect(unescaped(said())).toEqual([]);
    expect(said()).toContain(
      String.raw`"displayName": "Lost\u001b[2K laptop\r3f2a91c4\u009b1A\u009d0;Studio Mac\u009c\u007f",`,
    );
    expect(JSON.parse(said())).toEqual([
      expect.objectContaining({ runtimeId: DESK }),
      { ...hostile, revoked: false, revokedAt: null },
    ]);

    // The answer to a revocation is printed the same way, whatever it holds.
    output.length = 0;
    revokeAnswer = { revoked: [`${DESK}\u009b2J`], pendingEnded: [`\u202e${PENDING}\u2028`] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK], yes: true, json: true });
    expect(unescaped(said())).toEqual([]);
    expect(JSON.parse(said())).toEqual(revokeAnswer);
  });

  it("escapes the ids the server sent too, in the question and in what it says it revoked", async () => {
    // The controller makes the ids, yet nothing it sends is printed for a terminal to act on.
    const strange = { ...listed[0], runtimeId: `\u202e${HOSTILE}\u001b[2K\u009b2J`, displayName: "Spare desk" };
    listing = [listed[0], strange];
    setTerminal(true);
    ask.mockResolvedValueOnce(false);
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true })).rejects.toThrow("Cancelled.");
    expect(said()).toContain(String.raw`  \u202e3f2a91c · Spare desk · Garden plans (\u202e${HOSTILE}\u001b[2K\u009b2J)`);
    expect(unescaped(said())).toEqual([]);
    expect(posts()).toEqual([]);

    output.length = 0;
    revokeAnswer = { revoked: [`\u202e${DESK}`], pendingEnded: [`\u009b${PENDING}`] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK], yes: true });
    expect(said()).toContain(String.raw`Revoked 1 machine: \u202e3f2a91c`);
    expect(said()).toContain(String.raw`Ended 1 token for a machine that had not connected yet: \u009b9b7e0d2`);
    expect(unescaped(said())).toEqual([]);
    expect(posts()).toHaveLength(1);
  });

  it("revokes the machines a unique prefix names, each once, after --yes", async () => {
    revokeAnswer = { revoked: [DESK], pendingEnded: [PENDING] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: ["3f2a91c4", DESK, "9B7E"], yes: true });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /me/runtimes",
      "POST /me/runtimes/revoke",
    ]);
    expect(requests[1]?.body).toEqual({ runtimeIds: [DESK, PENDING] });
    expect(said()).toContain("Revoked 1 machine: 3f2a91c4");
    expect(said()).toContain("Ended 1 token for a machine that had not connected yet: 9b7e0d21");
    expect(said()).toContain("Revoking does not sign you out on a machine");
    expect(said()).not.toContain("already revoked");
  });

  it("says which machines named were already revoked, which the server skips", async () => {
    revokeAnswer = { revoked: [DESK], pendingEnded: [] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK, "5c1d"], yes: true });
    expect(posts().map((request) => request.body)).toEqual([{ runtimeIds: [DESK, OLD] }]);
    expect(said()).toContain("Revoked 1 machine: 3f2a91c4");
    expect(said()).toContain("1 machine was already revoked: 5c1d2e3f");
  });

  it("neither asks nor sends anything when every machine named is revoked already", async () => {
    listing = [...listed, gone];
    const oldOnly = [
      expect.stringContaining("There was nothing to revoke."),
      expect.stringContaining("1 machine was already revoked: 5c1d2e3f"),
    ];
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [OLD], yes: true });
    expect(output).toEqual(oldOnly);

    // Without --yes there is nothing to ask at a terminal, and nothing to refuse anywhere else.
    for (const terminal of [true, false]) {
      setTerminal(terminal);
      output.length = 0;
      await runtimeRevoke({ ...auth(), idsOrPrefixes: [OLD] });
      expect(output).toEqual(oldOnly);
    }
    output.length = 0;
    await runtimeRevoke({ ...auth(), idsOrPrefixes: ["5c1d", GONE] });
    expect(output).toEqual([
      expect.stringContaining("There was nothing to revoke."),
      expect.stringContaining("2 machines were already revoked: 5c1d2e3f, 8d9e0f1a"),
    ]);

    // --json prints the empty answer the server would have given, with --yes or without.
    for (const yes of [true, false]) {
      output.length = 0;
      await runtimeRevoke({ ...auth(), idsOrPrefixes: [OLD], yes, json: true });
      expect(JSON.parse(said())).toEqual({ revoked: [], pendingEnded: [] });
    }

    expect(ask).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
  });

  it("asks about the machines named that are not revoked yet, and marks the others", async () => {
    setTerminal(true);
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    revokeAnswer = { revoked: [DESK], pendingEnded: [] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK, OLD] });
    expect(ask).toHaveBeenLastCalledWith({ message: "Revoke this machine?", initialValue: false });
    expect(output).toEqual([
      expect.stringContaining(`  3f2a91c4 · Studio Mac · Garden plans (${DESK})`),
      expect.stringContaining(`  5c1d2e3f · Old laptop · Shared lab (${OLD}), already revoked`),
      expect.stringContaining("Its access to the space listed ends now, and it stops if it is running."),
      expect.stringContaining("A computer used in several spaces is listed once per space"),
      expect.stringContaining("Revoked 1 machine: 3f2a91c4"),
      expect.stringContaining("1 machine was already revoked: 5c1d2e3f"),
      expect.stringContaining("Revoking does not sign you out on a machine"),
    ]);
    expect(output[0]).not.toContain("already revoked");
    // Every machine named is sent: one started again since the list was read is revoked as well.
    expect(posts().map((request) => request.body)).toEqual([{ runtimeIds: [DESK, OLD] }]);

    output.length = 0;
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK, PENDING, OLD] })).rejects.toThrow("Cancelled.");
    expect(ask).toHaveBeenLastCalledWith({ message: "Revoke these 2 machines?", initialValue: false });
    expect(said()).toContain("Their access to the spaces listed ends now, and the ones running stop.");
    expect(said()).toContain(`(${OLD}), already revoked`);
    expect(posts()).toHaveLength(1);
  });

  it("reports as already revoked what the answer leaves out, whatever the list said", async () => {
    // Listed as not revoked, then revoked from elsewhere before the request: the answer leaves it out.
    revokeAnswer = { revoked: [], pendingEnded: [] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK], yes: true });
    expect(posts().map((request) => request.body)).toEqual([{ runtimeIds: [DESK] }]);
    expect(output).toEqual([
      expect.stringContaining("There was nothing to revoke."),
      expect.stringContaining("1 machine was already revoked: 3f2a91c4"),
    ]);

    // Listed as revoked, then started again before the request: the answer lists it as revoked now.
    output.length = 0;
    revokeAnswer = { revoked: [DESK, OLD], pendingEnded: [] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK, OLD], yes: true });
    expect(posts().map((request) => request.body)).toEqual([{ runtimeIds: [DESK] }, { runtimeIds: [DESK, OLD] }]);
    expect(said()).toContain("Revoked 2 machines: 3f2a91c4, 5c1d2e3f");
    expect(said()).not.toContain("already revoked");
  });

  it("revokes all your machines with --all, without reading the list", async () => {
    revokeAnswer = { revoked: [DESK, BROWSER], pendingEnded: [PENDING] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true, yes: true, json: true });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /me/runtimes/revoke"]);
    expect(requests[0]?.body).toEqual({ all: true });
    expect(JSON.parse(said())).toEqual({ revoked: [DESK, BROWSER], pendingEnded: [PENDING] });
  });

  it("refuses an ambiguous or unknown id, or ids with --all, before revoking anything", async () => {
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: ["3f2a91c"], yes: true })).rejects.toThrow(
      /ambiguous; it matches 2 machines/,
    );
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: ["ffff"], yes: true })).rejects.toThrow(
      'No machine of yours matches "ffff"',
    );
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK], all: true, yes: true })).rejects.toThrow(
      "not both",
    );
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [" "], yes: true })).rejects.toThrow("--all");
    expect(posts()).toEqual([]);
  });

  it("never revokes without --yes outside a terminal", async () => {
    setTerminal(false);
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK] })).rejects.toThrow(
      "Refusing to revoke this machine without confirmation. Re-run with --yes.",
    );
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true })).rejects.toThrow(
      "Refusing to revoke all your machines without confirmation. Re-run with --yes.",
    );
    // Output piped elsewhere, or input that is not a person's.
    for (const [stdin, stdout] of [[true, false], [false, true]] as const) {
      setTerminal(stdin, stdout);
      await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK] })).rejects.toThrow("Re-run with --yes.");
    }
    expect(ask).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
  });

  it("needs --yes with --json or in CI, even at a terminal", async () => {
    setTerminal(true);
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK], json: true })).rejects.toThrow(
      "Refusing to revoke this machine without confirmation. Re-run with --yes.",
    );
    vi.stubEnv("CI", "true");
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true })).rejects.toThrow(
      "Refusing to revoke all your machines without confirmation. Re-run with --yes.",
    );
    expect(ask).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
  });

  it("asks at a terminal, and revokes nothing when the answer is no or the question is cancelled", async () => {
    setTerminal(true);
    ask.mockResolvedValueOnce(false).mockResolvedValueOnce(Symbol("cancel"));
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: ["3f2a91c4"] })).rejects.toThrow("Cancelled.");
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: ["3f2a91c4"] })).rejects.toThrow("Cancelled.");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledWith({ message: "Revoke this machine?", initialValue: false });
    expect(said()).toContain(`  3f2a91c4 · Studio Mac · Garden plans (${DESK})`);
    // One row is one runtime in one space: the same computer's rows in other spaces keep their access.
    expect(said()).toContain("Its access to the space listed ends now, and it stops if it is running.");
    expect(said()).toContain("A computer used in several spaces is listed once per space");
    expect(said()).not.toContain("in every space");
    expect(posts()).toEqual([]);
  });

  it("revokes exactly the machines named once the answer is yes", async () => {
    setTerminal(true);
    ask.mockResolvedValueOnce(true);
    revokeAnswer = { revoked: [DESK], pendingEnded: [PENDING] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: ["3f2a91c4", "9b7e"] });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith({ message: "Revoke these 2 machines?", initialValue: false });
    expect(posts()).toEqual([
      {
        method: "POST",
        path: "/me/runtimes/revoke",
        authorization: `Bearer ${TOKEN}`,
        body: { runtimeIds: [DESK, PENDING] },
      },
    ]);
    expect(said()).toContain(`  9b7e0d21 · New machine · Untitled space (${PENDING})`);
    expect(said()).toContain("Their access to the spaces listed ends now, and the ones running stop.");
    expect(said()).not.toContain("in every space");
    expect(said()).toContain("Revoked 1 machine: 3f2a91c4");
  });

  it("asks before --all about the machines not revoked yet, whose access ends in every space", async () => {
    setTerminal(true);
    ask.mockResolvedValueOnce(true);
    revokeAnswer = { revoked: [DESK, BROWSER], pendingEnded: [PENDING] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true });
    expect(ask).toHaveBeenCalledWith({ message: "Revoke all your machines?", initialValue: false });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /me/runtimes",
      "POST /me/runtimes/revoke",
    ]);
    expect(requests[1]?.body).toEqual({ all: true });
    for (const id of [DESK, BROWSER, PENDING]) expect(said()).toContain(`(${id})`);
    expect(said()).not.toContain("5c1d2e3f");
    expect(said()).toContain("Their access ends now, in every space, and the ones running stop.");
    expect(said()).not.toContain("A computer used in several spaces");
  });

  it("says there is nothing to revoke, without asking, when --all finds every machine revoked already", async () => {
    setTerminal(true);
    for (const machines of [[listed[3], gone], []]) {
      listing = machines;
      requests = [];
      output.length = 0;
      await runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true });
      expect(output).toEqual([expect.stringContaining("There was nothing to revoke.")]);
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /me/runtimes"]);
    }
    expect(ask).not.toHaveBeenCalled();

    // A token minted for a machine that has not connected yet can still be revoked.
    listing = [listed[3], gone, listed[2]];
    output.length = 0;
    ask.mockResolvedValueOnce(false);
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true })).rejects.toThrow("Cancelled.");
    expect(ask).toHaveBeenCalledWith({ message: "Revoke all your machines?", initialValue: false });
    expect(output.filter((line) => line.includes("(")).map((line) => line.trim())).toEqual([
      expect.stringContaining(`9b7e0d21 · New machine · Untitled space (${PENDING})`),
    ]);
    expect(posts()).toEqual([]);
  });

  it("refuses --all without --yes before reading anything, where no one can answer", async () => {
    const refusal = "Refusing to revoke all your machines without confirmation. Re-run with --yes.";
    // No terminal, or only half of one.
    for (const [stdin, stdout] of [[false, false], [true, false], [false, true]] as const) {
      setTerminal(stdin, stdout);
      await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true })).rejects.toThrow(refusal);
    }
    // --json, or CI, at a terminal.
    setTerminal(true);
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true, json: true })).rejects.toThrow(refusal);
    vi.stubEnv("CI", "true");
    await expect(runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true })).rejects.toThrow(refusal);
    expect(requests).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask with --yes, even at a terminal", async () => {
    setTerminal(true);
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [DESK], yes: true });
    expect(ask).not.toHaveBeenCalled();
    expect(posts().map((request) => request.body)).toEqual([{ runtimeIds: [DESK] }]);
  });

  it("says so when there was nothing to revoke", async () => {
    // With --yes, --all still sends its one request without reading the list.
    listing = [listed[3], gone];
    revokeAnswer = { revoked: [], pendingEnded: [] };
    await runtimeRevoke({ ...auth(), idsOrPrefixes: [], all: true, yes: true });
    expect(requests.map((request) => request.body)).toEqual([{ all: true }]);
    expect(output).toEqual([expect.stringContaining("There was nothing to revoke.")]);
  });

  it("is turned away with a sign-in hint when the token is not a person's sign-in", async () => {
    await expect(runtimeMachines({ controllerUrl: url, accessToken: "runtime-token" })).rejects.toThrow(/instafy login/);
  });

  it("matches exact ids before prefixes", () => {
    const records = listed.map(({ capabilities: _capabilities, ...record }) => record) as MachineRecord[];
    expect(resolveMachineRecords(records, [BROWSER]).map((record) => record.runtimeId)).toEqual([BROWSER]);
  });
});
