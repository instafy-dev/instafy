// read_offer: read one row's price from its store page. The binder runs it with node, cwd = the site folder.
// The store URL comes from data.json (items[].store.url), never from the click, so a viewer cannot point it anywhere.
// Every row ends with a value or a reason: a blocked or unreadable page answers "uncertain" with a short note.
// SPDX-License-Identifier: AGPL-3.0-only
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
await main(intent.params.ref);

async function main(ref) {
  let items = [];
  try {
    items = kit.readJson("data.json").items || [];
  } catch {
    return kit.error("invalid", "data.json could not be read");
  }
  const item = items.find((i) => i.ref === ref);
  const url = item?.store?.url;
  if (!item || !url) return kit.error("invalid", "this row has no store link");
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return kit.error("invalid", "the store link is not a web address");
  }
  const store = item.store.name || host;
  const blocked = (note) => {
    kit.records([kit.uncertain({ ref, attr: "price", url, note, label: "Price" })]);
    kit.done(note);
  };
  kit.progress(1, 2, `Reading ${host}`, host);
  let offers;
  try {
    offers = await kit.offers(await kit.fetch(url));
  } catch (error) {
    return blocked(error.code === "policy" ? `${host} blocks automated price checks`
      : error.code === "unavailable" ? `${host} did not answer just now; check again later` : `${host} could not be read`);
  }
  kit.progress(2, 2, `Reading the price on ${host}`, host);
  const offer = offers.find((o) => typeof o.amount === "number" && o.currency);
  if (!offer) return blocked(`no price on the ${host} page`);
  kit.records([
    {
      type: "offer",
      oid: kit.rid("off", ref, host),
      ref,
      seller: { name: store },
      price: { amount: offer.amount, currency: offer.currency },
      availability: /instock|limitedavailability|onlineonly/i.test(offer.availability || "") ? "in_stock" : /outofstock|soldout|discontinued/i.test(offer.availability || "") ? "out" : "unknown",
      handoff: { url, label: `Open ${store}` },
      basis: "live",
      prov: { source: host, url, ttl_s: 21600, class: "live" },
    },
  ]);
  kit.done(`${offer.currency} ${offer.amount} at ${store}`);
}
