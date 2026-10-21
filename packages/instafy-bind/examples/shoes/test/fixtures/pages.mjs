// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic product pages in the four JSON-LD shapes the shortlist uses (no copied page content).

const page = (blocks, extraHead = "") => `<!doctype html><html><head>
<meta property="og:site_name" content="Fixture Store">${extraHead}
${blocks.map((b) => `<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`).join("\n")}
</head><body><h1>Fixture</h1></body></html>`;

// ProductGroup → hasVariant by colour (Altra-like). Note the HTML entity in the name.
export const groupByColour = page([
  {
    "@context": "https://schema.org/", "@type": "ProductGroup", name: "Men&#39;s Test Pulse",
    brand: { "@type": "Brand", name: "testbrand" }, variesBy: ["https://schema.org/color"],
    hasVariant: [
      { "@type": "Product", name: "Men&#39;s Test Pulse - Red", color: "Red",
        offers: { "@type": "Offer", url: "https://shop.example/p?variant=1", priceCurrency: "USD", price: "150.0", availability: "https://schema.org/InStock" } },
      { "@type": "Product", name: "Men&#39;s Test Pulse - Blue", color: "Blue",
        offers: { "@type": "Offer", url: "https://shop.example/p?variant=2", priceCurrency: "USD", price: "130.0", availability: "https://schema.org/OutOfStock" } },
    ],
  },
  "{ broken json",
]);

// @graph ProductGroup with a ListPrice spec (On-like).
export const graphWithListPrice = page([
  {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Shop" },
      { "@type": "ProductGroup", name: "Men's Cloud Test", brand: { "@type": "Brand", name: "Cl" }, variesBy: ["https://schema.org/color"],
        hasVariant: [
          { "@type": "Product", color: "Black", offers: { "@type": "Offer", url: "https://other.example/black", price: 140, priceCurrency: "USD",
            availability: "https://schema.org/InStock",
            priceSpecification: { "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: 180, priceCurrency: "USD" } } },
        ] },
    ],
  },
]);

// Product with offers[] per size (norda-like), CAD.
export const offersPerSize = page([
  { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] },
  {
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "Product", name: "005 - M - Test", manufacturer: { "@type": "Organization", name: "trailco" },
      additionalProperty: [{ "@type": "PropertyValue", name: "Size", value: "M9, M10, M11" }],
      offers: [
        { "@type": "Offer", name: "M9", priceCurrency: "CAD", price: "325.0", availability: "https://schema.org/OutOfStock", url: "https://trail.example/p?v=9" },
        { "@type": "Offer", name: "M10", priceCurrency: "CAD", price: "325.0", availability: "https://schema.org/InStock", url: "https://trail.example/p?v=10",
          additionalProperty: [{ "@type": "PropertyValue", name: "size", value: "M10" }] },
        { "@type": "Offer", name: "M11", priceCurrency: "CAD", price: "325.0", availability: "https://schema.org/InStock", url: "https://trail.example/p?v=11" },
      ],
    }],
  },
]);

// ProductGroup varying by size (KARHU-like), EUR.
export const groupBySize = page([
  {
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "ProductGroup", name: "TEST FUSION", brand: { "@type": "Brand", name: "TESTCO" }, variesBy: ["https://schema.org/size"],
      hasVariant: ["42", "43", "44"].map((size, i) => ({
        "@type": "Product", name: `TEST FUSION - BLACK - ${size}`, size, color: "BLACK",
        offers: { "@type": "Offer", url: `https://eu.example/p?variant=${i}`, priceCurrency: "EUR", price: 170,
          availability: i === 1 ? "https://schema.org/OutOfStock" : "https://schema.org/InStock" },
      })),
    }],
  },
]);

// AggregateOffer without nested offers.
export const aggregate = page([
  { "@context": "https://schema.org", "@type": "Product", name: "Agg Shoe", brand: "AggCo",
    offers: { "@type": "AggregateOffer", lowPrice: "89.99", highPrice: "120", priceCurrency: "GBP", offerCount: 3, availability: "https://schema.org/InStock" } },
]);

export const noProduct = page([{ "@context": "https://schema.org", "@type": "Organization", name: "Nope" }]);
