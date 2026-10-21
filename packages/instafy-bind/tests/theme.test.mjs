// theme.css, the one shared look of the starter pages: every token in light and in both dark switches (the OS, and
// Studio's <html data-theme="dark">), readable contrast, Studio's shapes (no pills, no gradients, no navy surfaces),
// 44 px touch targets and no motion for people who turned it off. The bind client's toast uses the same tokens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CSS = fs.readFileSync(new URL("../src/starters/theme.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const CLIENT = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");

/** The body of the first `selector {` block found after `from`, braces balanced. */
function block(source, selector, from = 0) {
  const at = source.indexOf(selector, from);
  assert.ok(at >= 0, `${selector} is in theme.css`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${selector}`);
}
function tokens(body) {
  const out = {};
  for (const m of body.matchAll(/(--if-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const LIGHT = tokens(block(CSS, ":root {"));
const OS_DARK = tokens(block(block(CSS, "@media (prefers-color-scheme: dark)"), ':root:not([data-theme="light"])'));
const HOST_DARK = tokens(block(CSS, ':root[data-theme="dark"]'));
const LAYOUT = /^--if-(s\d|r-|font|page)/;

function hex(value) {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  assert.ok(m, `${value} is a #rrggbb colour`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("every colour token exists in light and in both dark switches, and the two dark blocks agree", () => {
  assert.ok(Object.keys(LIGHT).length > 50);
  assert.deepEqual(OS_DARK, HOST_DARK, "the OS dark block and Studio's data-theme=dark block are the same");
  for (const name of Object.keys(LIGHT)) {
    if (LAYOUT.test(name)) continue;
    assert.ok(name in OS_DARK, `${name} has a dark value`);
  }
  for (const name of Object.keys(OS_DARK)) assert.ok(name in LIGHT, `${name} also has a light value`);
  // color-scheme follows the same selectors, so native controls and scrollbars match
  assert.match(block(CSS, ":root {"), /color-scheme:\s*light/);
  assert.match(block(CSS, ':root[data-theme="dark"]'), /color-scheme:\s*dark/);
  assert.match(CSS, /:where\(body\)\s*\{[^}]*background:\s*var\(--if-bg\)/, "the body background is never transparent");
});

test("Studio's values: ink, accent, lines and radii", () => {
  assert.equal(LIGHT["--if-fg"], "#0F172A");
  assert.equal(LIGHT["--if-accent"], "#0066AC");
  assert.equal(LIGHT["--if-muted"], "#6F6B64"); // a touch darker than Studio's #75716A: captions on a selected row stay 4.5:1
  assert.equal(LIGHT["--if-line"], "#EBE7E2");
  assert.equal(LIGHT["--if-selected"], "#F6F3EF");
  assert.equal(OS_DARK["--if-bg"], "#141414");
  assert.equal(OS_DARK["--if-surface"], "#1D1D1D");
  assert.equal(OS_DARK["--if-float"], "#262626");
  assert.equal(OS_DARK["--if-accent"], "#2A72C6"); // Studio's #2D7CD7 is 4.2:1 with white; the one primary button needs 4.5
  assert.deepEqual(["--if-r-chip", "--if-r-btn", "--if-r-row", "--if-r-card"].map((k) => LIGHT[k]), ["6px", "8px", "12px", "16px"]);
  assert.match(LIGHT["--if-font"], /^Inter, system-ui/);
  assert.doesNotMatch(CSS, /@import|@font-face|fonts\.googleapis/, "no webfont request");
});

test("text is readable: 4.5:1 for every text colour on the page and on cards, light and dark", () => {
  for (const [scheme, t] of [["light", LIGHT], ["dark", OS_DARK]]) {
    for (const fg of ["--if-fg", "--if-fg-2", "--if-muted"]) {
      // --if-selected: a row chat selected (or ?open=) keeps its captions readable
      for (const bg of ["--if-bg", "--if-surface", "--if-selected"]) {
        const ratio = contrast(t[fg], t[bg]);
        assert.ok(ratio >= 4.5, `${scheme} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
  }
  assert.ok(contrast(LIGHT["--if-on-accent"], LIGHT["--if-accent"]) >= 4.5, "white on the light primary button");
  assert.ok(contrast(OS_DARK["--if-on-accent"], OS_DARK["--if-accent"]) >= 4.5, "white on the dark primary button");
  // a busy button ("Checking…") is not dimmed, so its label keeps the button's contrast
  assert.match(block(CSS, '.btn[aria-busy="true"] {'), /opacity:\s*1/);
  assert.ok(contrast(LIGHT["--if-link"], LIGHT["--if-surface"]) >= 4.5 && contrast(OS_DARK["--if-link"], OS_DARK["--if-surface"]) >= 4.5, "links");
});

test("Studio's shapes: no pill buttons or segments, no gradients, no slate-blue grey or navy surfaces", () => {
  for (const selector of [".btn {", ".seg {", ".seg span {", ".field input, .field select, .field textarea {"]) {
    assert.doesNotMatch(block(CSS, selector), /999px|--if-r-full/, `${selector} is not a pill`);
  }
  assert.doesNotMatch(CSS, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(CSS, /#64748b/i);
  for (const t of [LIGHT, OS_DARK]) {
    for (const surface of ["--if-bg", "--if-surface", "--if-float", "--if-control", "--if-selected"]) {
      assert.ok(!/^#(0F172A|020617|0B1220|1E293B)$/i.test(t[surface]), `${surface} is not navy or slate-950`);
    }
  }
  // blue is only for the primary button, links, focus and the checkbox
  const blues = new Set([LIGHT["--if-accent"], OS_DARK["--if-accent"]].map((v) => v.toLowerCase()));
  for (const [name, value] of Object.entries(LIGHT)) {
    if (/^--if-(accent|link|focus|check|field-focus)/.test(name)) continue;
    assert.ok(!blues.has(value.toLowerCase()), `${name} does not reuse the accent blue`);
  }
  assert.doesNotMatch(CSS, /text-transform:\s*uppercase|letter-spacing/, "no uppercase labels or letter-spaced headings");
});

test("touch: buttons, segments, fields and links in rows get 44 px under a coarse pointer; motion stops when asked", () => {
  const coarse = block(CSS, "@media (pointer: coarse)");
  assert.match(block(coarse, ".btn {"), /min-height:\s*44px/);
  assert.match(block(coarse, ".field input, .field select, .field textarea {"), /min-height:\s*44px/);
  assert.match(coarse, /\.trust a, \.cap a[^{]*\{[^}]*min-width:\s*44px[^}]*padding:\s*14px 8px/);
  assert.match(block(CSS, ".check {"), /min-height:\s*44px/);
  assert.match(block(CSS, "details.fold > summary {"), /min-height:\s*44px/);
  const reduced = block(CSS, "@media (prefers-reduced-motion: reduce)");
  assert.match(reduced, /transition:\s*none !important/);
  assert.match(reduced, /animation:\s*none !important/);
  assert.match(CSS, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--if-focus\);\s*outline-offset:\s*2px;?\s*\}/);
  assert.doesNotMatch(CSS.replace(/\.field input:focus, [^{]*\{[^}]*\}/, ""), /outline:\s*none/, "no outline: none without a replacement");
  // the fields' soft focus border is under 3:1, so the keyboard ring is the same strong ring as everywhere else
  assert.match(block(CSS, ".field input:focus-visible, .field select:focus-visible"), /outline:\s*2px solid var\(--if-focus\)/);
});

test("Studio's title bar hides the page's own h1 (still read by screen readers); the client's toast uses the theme tokens", () => {
  const rule = block(CSS, 'html[data-host-title="shown"] .title');
  assert.match(rule, /clip: rect\(0 0 0 0\)/);
  assert.doesNotMatch(rule, /display:\s*none/);
  assert.match(CLIENT, /var\(--bind-toast-bg,var\(--if-toast-bg,#262626\)\)/);
  assert.match(CLIENT, /var\(--bind-toast-ink,var\(--if-toast-fg,#fafafa\)\)/);
});

test("quiet trust captions and a calm control row", () => {
  // one link pattern (always underlined) at two weights (review v4: every citation in the link colour outshouted the
  // one primary button): a citation in a caption or a "Sources" line is quiet, an action keeps the link colour
  const cite = block(CSS, ".trust a, .cap a, .notes a {");
  assert.match(cite, /color:\s*var\(--if-muted\)/);
  assert.match(cite, /text-decoration:\s*underline/);
  assert.match(cite, /text-decoration-color:\s*var\(--if-line-strong\)/);
  assert.match(block(CSS, ".trust a.act, .trust .link-btn, .cap .link-btn {"), /color:\s*var\(--if-link\)/);
  assert.match(block(CSS, ".trust a:focus-visible, .cap a:focus-visible, .notes a:focus-visible {"), /color:\s*var\(--if-link\)/);
  // a caption part that wrapped takes its own line without its dot (site.js marks it after measuring)
  assert.match(block(CSS, ".trust .sp.is-wrap > .dot, .trust .meta.is-wrap > .lead {"), /display:\s*none/);
  // "Ask in chat" only where there is a chat
  assert.match(block(CSS, ".in-studio {"), /display:\s*none/);
  assert.match(block(CSS, 'html[data-host-title="shown"] .in-studio {'), /display:\s*inline/);
  assert.doesNotMatch(CSS, /\.trust a[^{]*\{[^}]*text-decoration:\s*none/, "no caption link without its underline");
  assert.doesNotMatch(CSS, /color:\s*inherit;\s*text-decoration:\s*none/);
  // a button's hover colour only where a pointer hovers (a tap on a phone must not leave it in the hover colour)
  assert.match(block(CSS, "@media (hover: hover)"), /\.btn\.primary:hover/);
  assert.doesNotMatch(CSS.replace(/@media \(hover: hover\) \{[\s\S]*?\n\}/, ""), /\.btn(\.primary|\.quiet)?:hover/);
  assert.match(block(CSS, ".trust .age, .trust .sp.keep"), /white-space:\s*nowrap/, "a separator stays with the short link or date after it");
  assert.match(block(CSS, ".facts .trust .sp.is-act > .dot"), /display:\s*none/, "in a narrow cell the row's action starts its own line, without a dot");
  // a segmented option is 36 px on a mouse too (the spec's height, the same as the map's focus options)
  assert.match(block(CSS, ".seg span {"), /min-height:\s*36px/);
  // the one primary button sits on the left when it is alone, and gets its own full-width line on a phone
  assert.doesNotMatch(CSS, /\.bar > \.primary \{ margin-left: auto/);
  assert.match(CSS, /\.bar > \.primary:not\(:first-child\)\s*\{\s*margin-left:\s*auto/);
  assert.match(block(CSS, "@media (max-width: 479px)"), /\.bar > \.primary\s*\{[^}]*flex:\s*1 1 100%/);
  // a row chat points at stays marked without motion
  assert.match(CSS, /\.is-highlighted[^{]*\{[^}]*var\(--if-selected\)/);
});
