import { describe, expect, it } from "vitest";
import {
  ASK_BUSY_TEXT,
  ASK_IN_FLIGHT_MAX_MS,
  ASK_WINDOW_MS,
  ASK_CHECKING_ACCESS_TEXT,
  ASK_SIGNED_OUT_TEXT,
  ASK_VIEW_ONLY_TEXT,
  askOutcomesFromRuns,
  buildSiteIntentMetadata,
  composerAskSender,
  createAskLimiter,
  humanizeRef,
  parseSiteAsk,
  renderAskMessage,
  siteAskAccess,
  type ComposerSubmit,
  type SiteAsk,
} from "../previewHost/siteAsks";
import { vi } from "vitest";

const payload = (overrides: Record<string, unknown> = {}) => ({
  id: "int_m1abc_x7k2", intent: "check_size", label: "Ask Octo",
  params: { url: "https://www.karhu.com/products/ikoni-3", ref: "shoes:karhu-ikoni-3", size: "10", attr: "size_10" },
  ref: "shoes:karhu-ikoni-3", ...overrides,
});
const ask = (overrides: Record<string, unknown> = {}): SiteAsk => {
  const parsed = parseSiteAsk(payload(overrides));
  if (!parsed.ok) throw new Error("fixture did not parse");
  return parsed.ask;
};

describe("reading an ask from a page", () => {
  it("takes the bind client's payload, with say, confirm, withheld and coarsened", () => {
    expect(parseSiteAsk(payload({ say: "Is size {size} in stock for {ref}?", confirm: true, withheld: ["note"], coarsened: ["near"] }))).toEqual({
      ok: true,
      ask: {
        id: "int_m1abc_x7k2", intent: "check_size", label: "Ask Octo",
        params: { url: "https://www.karhu.com/products/ikoni-3", ref: "shoes:karhu-ikoni-3", size: "10", attr: "size_10" },
        ref: "shoes:karhu-ikoni-3", say: "Is size {size} in stock for {ref}?", confirm: true, withheld: ["note"], coarsened: ["near"],
      },
    });
    expect(parseSiteAsk(payload({ ref: null, params: undefined }))).toMatchObject({ ok: true, ask: { ref: null, params: {}, confirm: false, say: null } });
  });

  it("refuses anything malformed or too large whole, keeping a usable id so the page hears why", () => {
    const refused: Array<Record<string, unknown>> = [
      { intent: "bad name!" },
      { label: "" },
      { label: "x".repeat(121) },
      { params: "size=10" },
      { params: { "bad key": 1 } },
      { params: { blob: "x".repeat(2100) } },
      { params: { a: { b: { c: { d: 1 } } } } },
      { params: { fn: () => 1 } },
      { ref: "not a ref" },
      { say: 3 },
      { say: "x".repeat(121) },
      { confirm: "yes" },
      { withheld: "note" },
      { coarsened: ["ok", "bad key"] },
    ];
    for (const overrides of refused) expect(parseSiteAsk(payload(overrides)), JSON.stringify(Object.keys(overrides))).toEqual({ ok: false, id: "int_m1abc_x7k2" });
    expect(parseSiteAsk(payload({ id: "../etc" }))).toEqual({ ok: false, id: null });
    expect(parseSiteAsk("ask")).toEqual({ ok: false, id: null });
  });
});

describe("the chat line Studio renders", () => {
  it("fills the intent's say template from the params, and names the site by the preview's title", () => {
    expect(renderAskMessage(ask({ say: "Is size {size} in stock for {ref}?" }), "Running shoes"))
      .toBe("Is size 10 in stock for Karhu ikoni 3? · via Running shoes");
  });

  it("without a say line: the label, what the click is about and a short summary of the params", () => {
    expect(renderAskMessage(ask(), "Running shoes")).toBe("Ask Octo · Karhu ikoni 3 (karhu.com, size 10) · via Running shoes");
    expect(renderAskMessage(ask({ label: "Explain this spike", ref: null, params: { series: "cpu", day: "2026-10-20" } }), "Costs"))
      .toBe("Explain this spike (series cpu, day 2026-10-20) · via Costs");
    // A rounded position reads as "my location", never as numbers.
    expect(renderAskMessage(ask({ label: "Quiet cafés", ref: null, params: { near: "52.37, 4.895", topic: "quiet" }, coarsened: ["near"] }), "Cafés"))
      .toBe("Quiet cafés (my location, quiet) · via Cafés");
  });

  it("lets nothing from the page format, link, mention or command anything", () => {
    const line = renderAskMessage(ask({
      label: "/goal clear", ref: null,
      say: "@everyone [click](https://evil.example) `rm -rf` **now** {size}",
      params: { size: "<img src=x>\n# heading" },
    }), "Shop\nnow");
    expect(line).not.toMatch(/[@[\]`*<>#\n]/);
    expect(line.startsWith("/")).toBe(false);
    expect(line).toContain("· via Shop now");
    // A line with no words left still says what it is.
    expect(renderAskMessage(ask({ label: "Ask Octo", say: "{missing}", params: {} }), "Site")).toBe("Ask Octo · via Site");
  });

  it("caps the line and the message", () => {
    const line = renderAskMessage(ask({ say: "{size}", params: { size: "x".repeat(400) } }), "y".repeat(300));
    expect([...line].length).toBeLessThanOrEqual(200);
    expect(humanizeRef("shoes:on-cloud_monster.2")).toBe("On cloud monster 2");
  });

  it("puts the structured intent in metadata.siteIntent, params as sent", () => {
    expect(buildSiteIntentMetadata("preview-1", ask({ withheld: ["note"] }))).toEqual({
      siteIntent: {
        previewId: "preview-1", askId: "int_m1abc_x7k2", intent: "check_size", ref: "shoes:karhu-ikoni-3",
        params: { url: "https://www.karhu.com/products/ikoni-3", ref: "shoes:karhu-ikoni-3", size: "10", attr: "size_10" }, withheld: ["note"],
      },
    });
  });
});

describe("the caps on one person's asks from one site", () => {
  it("one at a time, six in ten minutes, and a repeated id is dropped", () => {
    let now = 0;
    const limiter = createAskLimiter(() => now);
    expect(limiter.admit("u:p:s", "a")).toEqual({ ok: true });
    expect(limiter.admit("u:p:s", "b")).toEqual({ ok: false, reason: ASK_BUSY_TEXT });
    // Another site (or person) is not held up.
    expect(limiter.admit("u:p:other", "b")).toEqual({ ok: true });
    limiter.settle("u:p:s", "a");
    expect(limiter.admit("u:p:s", "a")).toMatchObject({ ok: false, duplicate: true });
    for (const id of ["c", "d", "e", "f", "g"]) {
      now += 1000;
      expect(limiter.admit("u:p:s", id)).toEqual({ ok: true });
      limiter.settle("u:p:s", id);
    }
    const seventh = limiter.admit("u:p:s", "h");
    expect(seventh.ok).toBe(false);
    expect(!seventh.ok && seventh.reason).toBe("You asked from this site 6 times in 10 minutes. Try again in 10 min.");
    now = ASK_WINDOW_MS + 1;
    expect(limiter.admit("u:p:s", "h")).toEqual({ ok: true });
  });

  it("an ask declined before sending does not count, and a run Studio never saw end stops holding the slot", () => {
    let now = 0;
    const limiter = createAskLimiter(() => now);
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.admit("k", `r${i}`)).toEqual({ ok: true });
      limiter.refund("k", `r${i}`);
    }
    expect(limiter.admit("k", "x")).toEqual({ ok: true });
    expect(limiter.admit("k", "y").ok).toBe(false);
    now = ASK_IN_FLIGHT_MAX_MS + 1;
    expect(limiter.admit("k", "y")).toEqual({ ok: true });
  });
});

describe("an ask's outcome from its runs", () => {
  const run = (askId: string | null, status: string, conversationId = "conv-1") =>
    ({ conversationId, status, metadata: askId ? { siteIntent: { askId } } : null });
  it("running while any run is, done when one succeeded, failed otherwise; other conversations and plain runs ignored", () => {
    const outcomes = askOutcomesFromRuns([
      run("a", "in_progress"), run("a", "success"),
      run("b", "failed"), run("b", "success"),
      run("c", "canceled"),
      run("d", "success", "conv-2"), run(null, "success"),
    ], "conv-1");
    expect(Object.fromEntries(outcomes)).toEqual({ a: "running", b: "done", c: "failed" });
    expect(askOutcomesFromRuns([run("a", "success")], null).size).toBe(0);
  });
});

describe("the conversation's side", () => {
  it("whoever may send messages may ask; anyone else gets one plain reason", () => {
    expect(siteAskAccess({ userId: "u", capabilitiesResolved: true, writeDisabled: false })).toBe(true);
    expect(siteAskAccess({ userId: "u", capabilitiesResolved: true, writeDisabled: true })).toBe(ASK_VIEW_ONLY_TEXT);
    expect(siteAskAccess({ userId: "u", capabilitiesResolved: false, writeDisabled: true })).toBe(ASK_CHECKING_ACCESS_TEXT);
    expect(siteAskAccess({ userId: null, capabilitiesResolved: true, writeDisabled: false })).toBe(ASK_SIGNED_OUT_TEXT);
    for (const reason of [ASK_VIEW_ONLY_TEXT, ASK_CHECKING_ACCESS_TEXT, ASK_SIGNED_OUT_TEXT]) expect(reason.length).toBeLessThanOrEqual(140);
  });

  it("sends through the composer as an app-made message to Octo, and a queued one counts as sent", async () => {
    const submit = vi.fn<ComposerSubmit>().mockResolvedValue(true);
    const send = composerAskSender(submit);
    await expect(send({ text: "Hi · via Site", metadata: { siteIntent: { askId: "a" } } })).resolves.toBe(true);
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      { message: "Hi · via Site", editorState: null, metadata: { siteIntent: { askId: "a" } }, targetAgentHandles: ["octo"] },
      expect.objectContaining({ automatic: true }),
    );
    submit.mockImplementationOnce(async (_override, options) => { options.onQueued(); return false; });
    await expect(send({ text: "Hi", metadata: {} })).resolves.toBe(true);
    submit.mockResolvedValueOnce(false);
    await expect(send({ text: "Hi", metadata: {} })).resolves.toBe(false);
  });
});
