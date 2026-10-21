// SPDX-License-Identifier: AGPL-3.0-only
//
// Read schema.org Product / ProductGroup / Offer / AggregateOffer JSON-LD out of a product page
// and turn it into uw.records@1 records. Pure functions; no I/O. The page is untrusted data:
// only typed fields are read, strings are length-capped, and nothing from the page is executed.

const AVAIL_IN = /(InStock|LimitedAvailability|OnlineOnly|InStoreOnly|PreSale|BackOrder)$/i;
const AVAIL_OUT = /(OutOfStock|SoldOut|Discontinued)$/i;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function clip(value, max) {
  const s = decodeEntities(String(value ?? "")).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Every JSON-LD block in the HTML, parsed. Blocks that are not valid JSON are skipped. */
export function extractJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = re.exec(html))) {
    let body = match[1].trim().replace(/^<!--/, "").replace(/-->$/, "").replace(/^\/\/<!\[CDATA\[|\/\/\]\]>$/g, "").trim();
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      try {
        // Common breakage: raw control characters inside strings, trailing commas.
        out.push(JSON.parse(body.replace(/[\u0000-\u001f]+/g, " ").replace(/,\s*([}\]])/g, "$1")));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function types(node) {
  const t = node?.["@type"];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map(String);
}

/** Top-level nodes, @graph members and array members, flattened. */
export function flattenNodes(blocks) {
  const nodes = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value["@graph"])) value["@graph"].forEach(visit);
    if (value["@type"]) nodes.push(value);
  };
  blocks.forEach(visit);
  return nodes;
}

/** The main product node: a ProductGroup if present, else the Product with the most offer data. */
export function pickProduct(nodes) {
  const groups = nodes.filter((n) => types(n).includes("ProductGroup") && n.name);
  if (groups.length) return groups.sort((a, b) => (b.hasVariant?.length || 0) - (a.hasVariant?.length || 0))[0];
  const products = nodes.filter((n) => types(n).includes("Product") && n.name && (n.offers || n.hasVariant));
  if (!products.length) return null;
  const weight = (p) => (Array.isArray(p.offers) ? p.offers.length : p.offers ? 1 : 0) + (p.hasVariant?.length || 0);
  return products.sort((a, b) => weight(b) - weight(a))[0];
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function availability(value) {
  const s = String(value || "");
  if (AVAIL_IN.test(s)) return "in_stock";
  if (AVAIL_OUT.test(s)) return "out";
  return "unknown";
}

function propValue(props, nameRe) {
  for (const p of asArray(props)) {
    if (p && nameRe.test(String(p.name || ""))) return p.value;
  }
  return undefined;
}

function brandName(node) {
  const b = node?.brand ?? node?.manufacturer;
  if (!b) return null;
  if (typeof b === "string") return b;
  if (Array.isArray(b)) return brandName({ brand: b[0] });
  return b.name ? String(b.name) : null;
}

function readOffer(offer, variant = {}) {
  if (!offer || typeof offer !== "object") return [];
  const t = types(offer);
  if (t.includes("AggregateOffer")) {
    const nested = asArray(offer.offers).flatMap((o) => readOffer(o, variant));
    if (nested.length) return nested;
    const low = num(offer.lowPrice ?? offer.price);
    if (low == null) return [];
    return [{
      price: low, high: num(offer.highPrice), currency: offer.priceCurrency || null,
      availability: availability(offer.availability), url: offer.url || null,
      size: variant.size ?? null, color: variant.color ?? null, listPrice: null, aggregate: true,
    }];
  }
  let price = num(offer.price);
  let currency = offer.priceCurrency || null;
  let listPrice = null;
  for (const spec of asArray(offer.priceSpecification)) {
    const sp = num(spec?.price);
    if (sp == null) continue;
    if (/ListPrice|StrikethroughPrice|MSRP/i.test(String(spec.priceType || ""))) listPrice = sp;
    else if (price == null) price = sp;
    if (!currency && spec.priceCurrency) currency = spec.priceCurrency;
  }
  if (price == null) return [];
  const offerSize = propValue(offer.additionalProperty, /^size$/i) ?? offer.itemOffered?.size;
  let size = variant.size ?? offerSize ?? null;
  if (size == null && typeof offer.name === "string" && offer.name.length <= 12 && /\d/.test(offer.name)) size = offer.name;
  return [{
    price, high: null, currency, availability: availability(offer.availability),
    url: offer.url || null, size: size == null ? null : String(size), color: variant.color ?? null,
    listPrice: listPrice != null && listPrice > price ? listPrice : null, aggregate: false,
  }];
}

/** Flat list of offers, one per variant/size where the page lists them. */
export function readOffers(product) {
  if (!product) return [];
  const out = [];
  const variesBySize = asArray(product.variesBy).some((v) => /size/i.test(String(v)));
  for (const v of asArray(product.hasVariant)) {
    if (!v || typeof v !== "object") continue;
    let size = v.size ?? propValue(v.additionalProperty, /^size$/i);
    if (size == null && variesBySize && typeof v.name === "string") {
      const tail = v.name.split(/\s[-–|/]\s/).pop();
      if (tail && tail.length <= 8 && /\d/.test(tail)) size = tail;
    }
    const variant = { size: size == null ? null : String(typeof size === "object" ? size.name ?? "" : size), color: v.color ? String(v.color) : null };
    for (const o of asArray(v.offers)) out.push(...readOffer(o, variant));
  }
  for (const o of asArray(product.offers)) out.push(...readOffer(o, {}));
  return out;
}

/** Product-level size list (e.g. additionalProperty "Size": "M8, M8.5, …") when offers don't carry sizes. */
function listedSizes(product) {
  const raw = propValue(product?.additionalProperty, /^(shoe )?size$/i);
  if (!raw) return [];
  return String(raw).split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 60);
}

export function normSize(value) {
  const s = String(value ?? "").toLowerCase().replace(/\b(us|eu|uk|men'?s|women'?s|size)\b/g, "").replace(/^\s*[mw](?=\d)/, "").trim();
  const n = Number.parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? String(n) : s.replace(/\s+/g, "");
}

function unique(list) {
  return [...new Set(list.filter((x) => x != null && x !== ""))];
}

/** Everything the grid needs from one product node. */
export function summarize(product) {
  const offers = readOffers(product);
  const currencies = offers.map((o) => o.currency).filter(Boolean);
  const currency = currencies.sort((a, b) => currencies.filter((c) => c === b).length - currencies.filter((c) => c === a).length)[0] || null;
  const same = offers.filter((o) => !currency || o.currency === currency);
  const inStock = same.filter((o) => o.availability === "in_stock");
  const pool = inStock.length ? inStock : same;
  const prices = pool.map((o) => o.price);
  const low = prices.length ? Math.min(...prices) : null;
  const high = Math.max(...pool.map((o) => o.high ?? o.price), -Infinity);
  const cheapest = pool.find((o) => o.price === low) || null;
  const listPrices = pool.map((o) => o.listPrice).filter((x) => x != null);
  const sizesFromOffers = unique(same.map((o) => o.size));
  const sizes = sizesFromOffers.length ? sizesFromOffers : listedSizes(product);
  const sizeInfo = sizesFromOffers.length
    ? sizesFromOffers.map((size) => ({ size, in_stock: same.some((o) => o.size === size && o.availability === "in_stock") }))
    : [];
  return {
    name: product?.name ? clip(product.name, 80) : null,
    brand: brandName(product) ? clip(brandName(product), 60) : null,
    currency,
    low,
    high: Number.isFinite(high) ? high : null,
    listPrice: listPrices.length ? Math.max(...listPrices) : null,
    availability: !same.length ? "unknown" : inStock.length ? "in_stock" : same.every((o) => o.availability === "out") ? "out" : "unknown",
    offerUrl: cheapest?.url || null,
    offerCount: same.length,
    colors: unique(same.map((o) => o.color)).map((c) => clip(c, 40)),
    sizes,
    sizeInfo,
    hasSizeStock: sizeInfo.length > 0,
  };
}

/** Parse a whole page. Returns null when there is no usable Product/Offer data. */
export function parseProductPage(html) {
  const product = pickProduct(flattenNodes(extractJsonLd(html)));
  if (!product) return null;
  const summary = summarize(product);
  if (summary.low == null) return { ...summary, noOffer: true };
  return summary;
}

export function siteNameFrom(html, host) {
  const m = html.match(/<meta[^>]+property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']{1,80})["']/i)
    || html.match(/<meta[^>]+content\s*=\s*["']([^"']{1,80})["'][^>]*property\s*=\s*["']og:site_name["']/i);
  return m ? clip(m[1], 60) : host;
}

function rid(value) {
  return String(value).replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 96);
}

function sizeRange(sizes) {
  if (!sizes.length) return null;
  const nums = sizes.map((s) => Number(normSize(s)));
  if (nums.every(Number.isFinite) && sizes.length > 3) {
    const lo = sizes[nums.indexOf(Math.min(...nums))];
    const hi = sizes[nums.indexOf(Math.max(...nums))];
    return `${lo}–${hi} (${sizes.length} sizes)`;
  }
  return clip(sizes.join(", "), 140);
}

const money = (amount, currency) => `${currency || ""} ${Number.isInteger(amount) ? amount : amount.toFixed(2)}`.trim();

/**
 * Build uw.records@1 records for one read. `trust` is "curated" when the URL is the seed URL for the ref.
 * The binder stamps prov.intent and prov.job; handlers never write files.
 */
export function buildRecords({ ref, pageUrl, host, siteName, summary, size, attr, trust = "unknown", now = new Date() }) {
  const at = now.toISOString();
  const key = rid(ref.split(":").slice(1).join(":") || ref);
  const source = host.replace(/^www\./, "");
  const provBase = { source, source_label: clip(siteName || source, 80), lane: "local", url: pageUrl, observed_at: at, observed_by: "read_offer.mjs" };
  const live = { ...provBase, ttl_s: 6 * 3600, class: "live" };
  const stored = { ...provBase, ttl_s: 7 * 86400, class: "stored" };
  const records = [];
  const claim = (attrName, value, extra, prov = live) => records.push({
    type: "claim", cid: rid(`clm_${key}_${attrName}_${source}`), ref, attr: attrName,
    value: typeof value === "string" ? clip(value, 140) : value, basis: "live", confidence: "high", ...extra, prov,
  });

  if (summary.brand) claim("brand", summary.brand, { label: "Brand", basis: "brand" }, stored);
  if (summary.name) claim("model", summary.name, { label: "Model", basis: "brand" }, stored);

  if (summary.low != null && summary.currency && /^[A-Z]{3}$/.test(summary.currency)) {
    const varied = summary.high != null && summary.high > summary.low;
    const kind = summary.listPrice ? "sale" : varied ? "from" : "regular";
    const handoff = summary.offerUrl && sameSite(summary.offerUrl, pageUrl) ? summary.offerUrl : pageUrl;
    records.push({
      type: "offer", oid: rid(`off_${key}_${source}`), ref,
      seller: { name: clip(siteName || source, 80), trust },
      price: { amount: summary.low, currency: summary.currency, kind },
      availability: summary.availability,
      handoff: { url: handoff, label: clip(`Open on ${source}`, 40) },
      label: clip(summary.colors.length > 1 ? `Lowest of ${summary.colors.length} colours` : summary.colors[0] || "Listed price", 80),
      basis: "live",
      prov: live,
    });
    if (summary.listPrice) claim("list_price", summary.listPrice, { label: "Was", unit: summary.currency });
  }

  claim("in_stock", summary.availability === "in_stock" ? "In stock" : summary.availability === "out" ? "Sold out" : "Unknown",
    { label: "Stock", status: summary.availability === "unknown" ? "uncertain" : "ok" });

  if (summary.sizes.length) {
    claim("sizes_listed", sizeRange(summary.sizes), { label: "Sizes listed" });
    if (summary.hasSizeStock) {
      const inStock = summary.sizeInfo.filter((s) => s.in_stock).map((s) => s.size);
      claim("sizes_in_stock", inStock.length ? sizeRange(inStock) : "None", { label: "Sizes in stock" });
    }
  } else {
    claim("sizes_listed", null, { label: "Sizes listed", status: "not_found", note: "This page's product data lists no sizes", confidence: "medium" });
  }
  if (summary.colors.length) claim("colors", `${summary.colors.length} · ${summary.colors.slice(0, 4).join(", ")}${summary.colors.length > 4 ? "…" : ""}`, { label: "Colours" });

  if (size && attr) {
    const want = normSize(size);
    const hit = summary.sizeInfo.find((s) => normSize(s.size) === want);
    const listed = summary.sizes.find((s) => normSize(s) === want);
    if (hit) {
      claim(attr, hit.in_stock ? "In stock" : "Sold out", { label: `Size ${clip(size, 12)}`, status: "ok" });
    } else if (summary.hasSizeStock) {
      claim(attr, "Not listed", { label: `Size ${clip(size, 12)}`, status: "not_found", note: `Listed: ${sizeRange(summary.sizes)}` });
    } else if (listed) {
      claim(attr, "Listed", { label: `Size ${clip(size, 12)}`, status: "uncertain", confidence: "medium", note: "Size is listed; this page's data has no stock per size" });
    } else {
      claim(attr, null, { label: `Size ${clip(size, 12)}`, status: "uncertain", confidence: "low", note: "The page data has no stock per size" });
    }
  }
  return records;
}

function sameSite(a, b) {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, "");
    const hb = new URL(b).hostname.replace(/^www\./, "");
    return ha === hb && new URL(a).protocol === "https:";
  } catch {
    return false;
  }
}

export function summaryLine(summary, host) {
  if (summary.low == null) return `${summary.name || host}: no price in the page's data`;
  const price = money(summary.low, summary.currency);
  const stock = summary.availability === "in_stock" ? "in stock" : summary.availability === "out" ? "sold out" : "stock unknown";
  return clip(`${summary.name || host}: ${summary.high > summary.low ? "from " : ""}${price}, ${stock}`, 140);
}
