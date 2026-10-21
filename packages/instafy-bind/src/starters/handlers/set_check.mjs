// set_check: store one tick of the checklist, so every viewer and device sees the same list.
// The binder keeps the claim (attr "done", or "done_<who>" for a per-person list) and streams it to every open page.
// Only refs and people listed in data.json are accepted.
// SPDX-License-Identifier: AGPL-3.0-only
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
main(intent.params);

function main({ ref, done, who, at }) {
  let data;
  try {
    data = kit.readJson("data.json");
  } catch {
    return kit.error("invalid", "data.json could not be read");
  }
  const refs = new Set((data.groups || []).flatMap((g) => (g.items || []).map((i) => i.ref)));
  if (!refs.has(ref)) return kit.error("invalid", "this item is not on the list");
  const people = Array.isArray(data.people) ? data.people : [];
  if (people.length && !people.includes(who)) return kit.error("invalid", "pick whose list first");
  if (!people.length && who) return kit.error("invalid", "this list is shared by everyone");
  const attr = who ? `done_${who.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x"}` : "done";
  // The click's own time orders quick tick / untick pairs; it is kept within the last ten minutes.
  const now = Date.now();
  const clicked = Date.parse(at || "");
  const observed = Number.isFinite(clicked) ? Math.min(now, Math.max(now - 600_000, clicked)) : now;
  kit.records([
    {
      type: "claim",
      cid: kit.rid("clm", ref, attr, "checklist"),
      ref,
      attr,
      value: done === true,
      label: "Done",
      status: "ok",
      basis: "user_note",
      confidence: "high",
      prov: { source: "checklist", lane: "local", observed_at: new Date(observed).toISOString(), ttl_s: 31536000 },
    },
  ]);
  kit.done(done ? "Ticked" : "Unticked");
}
