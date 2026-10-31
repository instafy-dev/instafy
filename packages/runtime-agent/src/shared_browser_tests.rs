use std::path::PathBuf;
use std::process::{Command as StdCommand, Output};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

use serde_json::json;

use super::*;

const SNAPSHOT_ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

const FAKE_PLAYWRIGHT: &str = r#"
const fs = require("fs");
const mode = process.env.INSTAFY_SHARED_BROWSER_FAKE_MODE || "safe";
// Assembled at run time so the source holds no key-shaped literal.
const CANARY = ["sk", "live", "INSTAFYCANARY0123456789abcdef"].join("_");
const markPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_MARK;
const cdpLogPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_CDP_LOG;
// The loaded document's CDP loader id, kept in a file so it lasts across
// controller processes the way one Chromium document does.
const documentPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_DOCUMENT;
const currentDocument = () => {
  try {
    return fs.readFileSync(documentPath, "utf8").trim() || "DOCUMENT1";
  } catch (_) {
    return "DOCUMENT1";
  }
};
const formButtonTypes = { "form-button": "button", "form-reset": "reset", "form-submit-button": "submit" };
const formInputTypes = { "form-submit-input": "submit", "form-image-input": "image" };
const isFormButton = Object.hasOwn(formButtonTypes, mode);
const hasForm = mode === "form-input" || isFormButton || Object.hasOwn(formInputTypes, mode);
const decoyLooksIdentical = mode === "identical-targets";
const approvalWasConsumed = () => {
  try {
    const state = JSON.parse(fs.readFileSync(
      `${process.env.INSTAFY_SHARED_BROWSER_APPROVAL_DIR}/state.json`,
      "utf8",
    ));
    return Array.isArray(state.consumedApprovalIds) && state.consumedApprovalIds.length > 0;
  } catch (_) {
    return false;
  }
};
// Structural facts as the page-side describer reports them.
const basePolicy = {
  href: "", linkSelf: false, download: false, formActionUrl: "", formName: "",
  formSubmitLabels: "", formHasPassword: false, formPasswordCount: 0, formFieldCount: 0,
  signInIdentifier: false, contentEditable: false, areas: "", menuOpener: false,
  credentialContext: false, row: false, nearMaskedText: false, iconHint: "",
};
const control = (text, extra = {}) => ({
  tag: "button", role: null, ariaLabel: "", labels: "", placeholder: "", inputType: "button",
  text, ...extra,
});
const siteSearch = {
  description: control("", {
    tag: "input", inputType: "search", ariaLabel: "Search places", labels: "Search places", formMethod: "get",
    formAction: "https://example.test/search", formActionText: "form get https://example.test/search Search",
  }),
  policy: {
    formActionUrl: "https://example.test/search", formSubmission: "implicit", formSubmits: true,
    formName: "Search", formSubmitLabels: "Search", formFieldCount: 1,
  },
};
// The entries the form sends, as the page's form-entries helper reports
// them: the field's own (its text left out for a type step), then the rest.
const formEntriesFor = (arg) => ({
  kind: "form-entries",
  complete: true,
  entries: [
    ["q", arg.keepOwn === false ? null : "Belém Tower"],
    ["lang", "en"],
    ...(mode === "site-search-key" ? [["k", ["sk", "live", "SEARCHKEY0123456789abcdef"].join("_")]] : []),
  ],
  own: 0,
});
// The fields a form step sends something from, by name, as the page's
// sent-fields helper reports them.
// A select's options, as the page's select-options helper reports them.
const selectOptionsFor = () => {
  const options = mode === "bulk-actions" ? BULK_ACTIONS : mode.startsWith("station-list") ? STATIONS : null;
  return options
    ? {
        kind: "select-options",
        select: true,
        options: options.map((label, index) => ({
          index,
          label,
          disabled: mode === "station-list-turned-off" && label === "Campanh\u00e3",
          chosen: index === (options === STATIONS ? STATIONS.length - 1 : 0),
        })),
      }
    : { kind: "select-options", select: false, options: [] };
};
const sentFieldsFor = (arg) => mode === "submit-order"
  ? ["Customer name", "Telephone", "E-mail address", "Pizza Size", "Delivery instructions"]
  : mode === "submit-order-many"
    ? ["Customer name", "Telephone", "E-mail address", "Pizza Size", "Pizza Toppings", "Preferred delivery time", "Delivery instructions"]
    : [];
// A journey planner's station list and a bulk-actions list, as the page
// describer reports a select: its text is every option run together, and it
// shows the option it holds.
const STATIONS = ["24 Agosto", "Aeroporto", "Aliados", "Campanh\u00e3", "S\u00e3o Bento", "Trindade"];
const BULK_ACTIONS = ["Select all", "Delete selected"];
const list = (label, options, shownText) => ({
  description: control(options.join(""), { tag: "select", inputType: "", labels: label, shownText }),
});
const special = {
  "station-list": list("Start", STATIONS, "Trindade"),
  // The same list as an older describer named it: by every option, run together.
  "station-list-run-together": list("Start", STATIONS, STATIONS.join("")),
  // Campanhã is an option the page turned off.
  "station-list-turned-off": list("Start", STATIONS, "Trindade"),
  "station-list-secret-screen": list("Start", STATIONS, "Trindade"),
  "bulk-actions": list("Bulk actions", BULK_ACTIONS, "Select all"),
  "invite-button": { description: control("Invite member") },
  "generate-key": { description: control("Generate API key") },
  "plain-button": { description: control("Show details") },
  // A cookie banner's refusal, and the same words where no banner is.
  "cookie-reject": { description: control("Reject all"), policy: { consentContext: true, areas: "dialog" } },
  "cookie-reject-pt": { description: control("Rejeitar todos"), policy: { consentContext: true, areas: "dialog" } },
  "cookie-reject-posts": { description: control("Reject all"), policy: { consentContext: true, areas: "dialog" } },
  "cookie-accept": { description: control("Accept all"), policy: { consentContext: true, areas: "dialog" } },
  // The accept of a common consent dialog says "Consent"; "accept" is not in it.
  "cookie-consent": { description: control("Consent"), policy: { consentContext: true, areas: "dialog" } },
  // Accepts limited to the necessary cookies: refusals in effect.
  "cookie-accept-necessary": {
    description: control("Accept only necessary"), policy: { consentContext: true, areas: "dialog" },
  },
  "cookie-accept-necessary-pt": {
    description: control("Aceitar apenas necess\u00e1rios"), policy: { consentContext: true, areas: "dialog" },
  },
  // A banner's accept as a link ("aceitar e continuar" is <a href>), which
  // the plain-link rule would otherwise take as navigation.
  "cookie-accept-link": {
    description: control("aceitar e continuar", { tag: "a", inputType: "", href: "https://example.test/pages/329" }),
    policy: { href: "https://example.test/pages/329", linkSelf: true, consentContext: true },
  },
  "reject-outside-banner": { description: control("Reject all") },
  // A form's submit button, and the fields its form sends something from,
  // as the page's sent-fields helper names them.
  "submit-order": {
    description: control("Submit order", {
      inputType: "submit", formMethod: "post", formAction: "https://example.test/post",
      formActionText: "form post https://example.test/post Submit order",
    }),
    policy: {
      formActionUrl: "https://example.test/post", formSubmission: "button", formSubmits: true,
      formName: "Submit order", formSubmitLabels: "Submit order", formFieldCount: 4,
    },
  },
  // A banner button whose name says more than the text it shows.
  "learn-more": {
    description: control("Learn More \u2192", { ariaLabel: "Learn More: Configure your consents" }),
    policy: { consentContext: true, areas: "dialog" },
  },
  // Script-driven save buttons: no form owner, only the commit word.
  "save-button": { description: control("Speichern") },
  "save-button-en": { description: control("Save changes") },
  // Menus, tabs, tree items, openers and navigation items whose label holds
  // a commit word. Their structure, not the word, decides.
  "menu-item-new": {
    description: control("Neue Rechnung", { tag: "li", role: "menuitem", inputType: "" }),
    policy: { areas: "menu" },
  },
  "tab-start": {
    description: control("Start", { tag: "div", role: "tab", inputType: "" }),
    policy: { areas: "tablist" },
  },
  "tree-item-new": {
    description: control("Neuer Ordner", { tag: "div", role: "treeitem", inputType: "" }),
    policy: { areas: "tree" },
  },
  "summary-edit": { description: control("Bearbeiten", { tag: "summary", inputType: "" }) },
  // Menu items whose label records or finalizes something (bookkeeping
  // German and English) ask even under routine browsing; a menu item that
  // only names a list ("Buchungen") stays navigation.
  "menu-item-finalize": {
    description: control("Festschreiben", { tag: "li", role: "menuitem", inputType: "" }),
    policy: { areas: "menu" },
  },
  "menu-item-book": {
    description: control("Buchen", { tag: "li", role: "menuitem", inputType: "" }),
    policy: { areas: "menu" },
  },
  "menu-item-mark-paid": {
    description: control("Als bezahlt markieren", { tag: "li", role: "menuitem", inputType: "" }),
    policy: { areas: "menu" },
  },
  "menu-item-save": {
    description: control("Speichern", { tag: "li", role: "menuitem", inputType: "" }),
    policy: { areas: "menu" },
  },
  "menu-item-mark-paid-en": {
    description: control("Mark as paid", { tag: "li", role: "menuitem", inputType: "" }),
    policy: { areas: "menu" },
  },
  "menu-item-bookings": {
    description: control("Buchungen", { tag: "li", role: "menuitem", inputType: "" }),
    policy: { areas: "menu" },
  },
  "opener-new": { description: control("Neu"), policy: { menuOpener: true } },
  "nav-start": { description: control("Start"), policy: { areas: "nav" } },
  "cross-site-link": {
    description: control("Pricing", { tag: "a", inputType: "", href: "https://other.example/pricing" }),
    policy: { href: "https://other.example/pricing", linkSelf: true },
  },
  "link-only-link": {
    description: control("Book this hotel", { tag: "a", inputType: "", href: "https://www.booking.com/hotel/fixture.html" }),
    policy: { href: "https://www.booking.com/hotel/fixture.html", linkSelf: true },
  },
  "export-link": {
    description: control("Export CSV", { tag: "a", inputType: "", href: "https://example.test/reports/export.csv" }),
    policy: { href: "https://example.test/reports/export.csv", linkSelf: true },
  },
  "reveal-key": { description: control("Show"), policy: { credentialContext: true, row: true } },
  "credential-row": {
    description: control("Production key ••••••••", { tag: "tr", inputType: "" }),
    policy: { credentialContext: true, row: true, nearMaskedText: true },
  },
  "sign-in-email": {
    description: control("", {
      tag: "input", inputType: "email", ariaLabel: "Email", labels: "Email", autocomplete: "email",
      formMethod: "post", formAction: "https://example.test/session", formActionText: "form post Sign in",
    }),
    policy: { formHasPassword: true, formPasswordCount: 1, formFieldCount: 2, signInIdentifier: true },
  },
  "file-input": { description: control("", { tag: "input", inputType: "file", ariaLabel: "Receipt" }) },
  // Form steps as the page describer reports them, with the submission the
  // browser makes (formSubmission.js): a label that clicks a hidden submit
  // button posting to another site, a search field whose default button opens
  // another window, and a field whose default button closes a dialog.
  "label-submits-elsewhere": {
    description: control("Read the reviews", {
      tag: "label", inputType: "", formMethod: "post", formAction: "https://other.example/collect",
      formActionText: "form post https://other.example/collect Read the reviews",
    }),
    policy: { formActionUrl: "https://other.example/collect", formSubmission: "button", formSubmits: true },
  },
  "new-window-search": {
    description: control("", {
      tag: "input", inputType: "search", ariaLabel: "Search", labels: "Search", formMethod: "get",
      formAction: "https://example.test/search", formTarget: "_blank",
      formActionText: "form get https://example.test/search Search",
    }),
    policy: {
      formActionUrl: "https://example.test/search", formSubmission: "implicit", formSubmits: true, formNewWindow: true,
    },
  },
  "dialog-field": {
    description: control("", {
      tag: "input", inputType: "text", ariaLabel: "Name", labels: "Name", formMethod: "dialog",
      formAction: "https://other.example/collect", formActionText: "form dialog https://other.example/collect Done",
    }),
    policy: { formActionUrl: "https://other.example/collect", formSubmission: "implicit", formSubmits: true },
  },
  // A field inside a submit button that posts to another site: a click
  // submits through that button, Enter through the default button.
  "field-inside-submit-button": {
    description: control("", {
      tag: "input", inputType: "text", ariaLabel: "Shoe size", labels: "Shoe size", formMethod: "post",
      formAction: "https://other.example/collect", formActionText: "form post https://other.example/collect Shoe size",
    }),
    policy: { formActionUrl: "https://other.example/collect", formSubmission: "nested", formSubmits: true },
  },
  // The site's own search box: Enter sends a GET of the page's own origin.
  // "-posts-own" pages turn it into a post to their own site when Enter is
  // pressed; "-key" forms send a hidden key-like value.
  "site-search": siteSearch,
  "site-search-posts-own": siteSearch,
  "site-search-key": siteSearch,
  "canary-label": { description: control(`Copy ${CANARY}`) },
  "click-error-canary": { description: control("Show details") },
  "no-policy": { description: control("Show details"), policy: null },
  "url-label": {
    description: control(`Open https://github.com/instafy-dev/instafy/pull/615/files?token=${CANARY}`),
  },
  // A bookkeeping app's header as the page describer reports it: a
  // hamburger <button> with no type attribute and no aria-expanded, which the
  // browser reports as type "submit" outside any form, and an unnamed avatar
  // button that opens the profile menu.
  "ff-menu-toggle": {
    description: control("", {
      inputType: "submit", titleAttribute: "Menü ein-/ausklappen", nameAttribute: "", idAttribute: "",
    }),
    policy: { iconHint: "sidebar-toggle fa fa-bars" },
  },
  "ff-avatar": {
    description: control("", { inputType: "submit", nameAttribute: "", idAttribute: "" }),
    policy: { menuOpener: true, iconHint: "profile-button avatar" },
    nameHints: { tooltip: "", describedBy: "", image: "", hasImage: true, position: "top right" },
  },
  // A disclosure button and a field in a page-wide POST form whose text holds
  // commit words, and that form's own submit button.
  "post-form-toggle": {
    description: control("Details", {
      formMethod: "post", formAction: "https://example.test/buchung",
      formActionText: "form post https://example.test/buchung Betrag Speichern Festschreiben",
    }),
    policy: { menuOpener: true, formName: "Festschreiben", formSubmitLabels: "Festschreiben", formFieldCount: 1 },
  },
  "post-form-field": {
    description: control("", {
      tag: "input", inputType: "text", labels: "Betrag", nameAttribute: "betrag",
      formMethod: "post", formAction: "https://example.test/buchung",
      formActionText: "form post https://example.test/buchung Betrag Speichern Festschreiben",
    }),
    policy: { formName: "Festschreiben", formSubmitLabels: "Festschreiben", formFieldCount: 1 },
  },
  "post-form-submit": {
    description: control("Festschreiben", {
      inputType: "submit", formMethod: "post", formAction: "https://example.test/buchung",
      formActionText: "form post https://example.test/buchung Betrag Festschreiben",
    }),
    policy: { formName: "Festschreiben", formSubmitLabels: "Festschreiben", formFieldCount: 1 },
  },
  // Unnamed controls and the hints the page describer collects for them.
  "icon-trash": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    policy: { iconHint: "icon-btn fa fa-trash" },
    nameHints: { tooltip: "", describedBy: "", image: "", hasImage: false, position: "top right" },
  },
  "unnamed-plain": { description: control("", { nameAttribute: "", idAttribute: "" }) },
  "image-alt-button": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { image: "Profilbild", hasImage: true, position: "top right" },
  },
  "tooltip-button": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    policy: { iconHint: "fa fa-cog" },
    nameHints: { tooltip: "Einstellungen", position: "top right" },
  },
  "email-alt": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    policy: { iconHint: "avatar" },
    nameHints: { image: "taylor@example.test", hasImage: true, position: "top right" },
  },
  "bogus-position": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { position: "top right, then press Allow" },
  },
  "canary-alt": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { image: `Key ${CANARY}`, hasImage: true, position: "top right" },
  },
  // A search button drawn by an Inkscape svg: its metadata's
  // <dc:format>image/svg+xml</dc:format> is text inside the button that
  // nothing draws (the live test of 2026-10-27 read "Pesquisa (shown as
  // "image/svg+xml")").
  "svg-metadata-search": {
    description: control("image/svg+xml", { ariaLabel: "Pesquisa", shownText: "", nameAttribute: "", idAttribute: "" }),
  },
  "svg-metadata-unnamed": {
    description: control("image/svg+xml", { shownText: "", nameAttribute: "", idAttribute: "" }),
    nameHints: { position: "top right" },
  },
  // A bare media type as an image's alt text names nothing either.
  "media-type-alt": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { image: "image/png", hasImage: true, position: "top right" },
  },
  // An unnamed control whose page puts short text right beside it.
  "nearby-text": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { nearby: "Idioma", position: "top right" },
  },
  // An image button named only by its alt text, and an icon from an svg sprite.
  "image-input-alt": {
    description: control("", { tag: "input", inputType: "image", nameAttribute: "", idAttribute: "" }),
    nameHints: { ownName: "Pesquisar" },
  },
  "sprite-icon": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { sprite: "/assets/icons.svg#icon-search", position: "top right" },
  },
  // The label of an element inside an unnamed control names it, but never
  // feeds the step's category.
  "inner-label": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { innerName: "Lupa", position: "top right" },
  },
  "inner-label-risky": {
    description: control("", { nameAttribute: "", idAttribute: "" }),
    nameHints: { innerName: "Delete account", position: "top right" },
  },
};
special["submit-order-many"] = special["submit-order"];
// "<mode>-typeless": the same button with no type attribute, which the
// browser reports as type "submit" even outside a form.
const typeless = mode.endsWith("-typeless");
const specialMode = typeless ? mode.slice(0, -"-typeless".length) : mode;
// "long-label-<n>": an accessible name and a long visible text that differ,
// shifted by n characters so the label cut lands on every position of a
// space and a four-byte character.
if (mode.startsWith("long-label-")) {
  const shift = "x".repeat(Number(mode.slice("long-label-".length)));
  special[mode] = {
    description: control(`${shift}Quarterly ${"team \u{1F600} ".repeat(40)}`, {
      tag: "a", inputType: "", ariaLabel: "Open report", href: "https://example.test/reports/q3",
    }),
    policy: { href: "https://example.test/reports/q3", linkSelf: true },
  };
}
// "button:<label>": a script-driven button with that label and no form
// (add "-typeless" for one without a type attribute). "post-form-button:<label>":
// a type="button" control inside a page-wide POST form whose own submit is
// "Speichern". "menu-item:<label>": a menu item with that label.
const labelled = /^(button|post-form-button|menu-item):(.+)$/u.exec(specialMode);
if (labelled) {
  const [, kind, label] = labelled;
  special[specialMode] = kind === "menu-item"
    ? { description: control(label, { tag: "li", role: "menuitem", inputType: "" }), policy: { areas: "menu" } }
    : kind === "post-form-button"
      ? {
          description: control(label, {
            formMethod: "post", formAction: "https://example.test/app",
            formActionText: "form post https://example.test/app Betrag Speichern",
          }),
          policy: { formName: "Buchhaltung", formSubmitLabels: "Speichern", formFieldCount: 1 },
        }
      : { description: control(label) };
}
const descriptionFor = (targetId) => ({
  tag: isFormButton || mode === "localized-button" || mode === "icon-button" ? "button" : "input",
  role: mode === "icon-button" ? "button" : null,
  idAttribute:
    mode === "reordered" || (mode === "stale-after-allow" && approvalWasConsumed())
      ? "changed-target"
      : "search",
  ariaLabel:
    mode === "localized-button" ? "Eliminar elemento" :
    mode === "icon-button" ? "" :
    targetId === "decoy-target" && !decoyLooksIdentical ? "Decoy field" : "Search",
  ariaLabelledBy: mode.startsWith("aria-") ? "external-label" : "",
  ariaLabelledByText:
    mode === "aria-delete" ? "Delete account" :
    mode === "aria-sensitive" ? "One time verification code" : "",
  placeholder: mode === "localized-button" || mode === "icon-button" ? "" : "Search",
  nameAttribute: mode === "password-name" ? "password" : "query",
  titleAttribute: null,
  valueAttribute: mode === "delete-value" ? "Delete account" : null,
  href: null,
  inputType: formButtonTypes[mode] || formInputTypes[mode] || "text",
  autocomplete: mode === "credit-card" ? "section-checkout shipping cc-private-token" : "off",
  inputMode: "text",
  formAction: hasForm ? "https://example.test/search" : "",
  formMethod: hasForm ? "get" : "",
  formActionText: hasForm ? "Search form" : "",
  labels: mode === "localized-button" || mode === "icon-button" ? "" : "Search",
  text: mode === "localized-button" ? "Eliminar" : "",
  ...(special[specialMode]?.description || {}),
  ...(typeless ? { inputType: "submit" } : {}),
  policy: special[specialMode] && special[specialMode].policy === null
    ? null
    : { ...basePolicy, ...(special[specialMode]?.policy || {}) },
  nameHints: special[specialMode]?.nameHints ?? null,
});
// The page describer's answers for the page's controls, in document order.
// "hidden-*" modes put a control a person cannot see ahead of the visible
// one; "page-links" lists links and a toggle.
const clickLogPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_CLICK_LOG;
const controlsFor = (targetId) => {
  if (mode === "hidden-controls" || mode === "hidden-secret-name") {
    return [
      { shown: false, name: mode === "hidden-secret-name" ? `Copy ${CANARY}` : "Kontenplan" },
      descriptionFor(targetId),
      // An icon-only button in a closed menu has no name.
      { shown: false, name: "" },
    ];
  }
  // A sign-in form as the page describer reports it: the account's email
  // (the field right before the password), the password, "Keep me signed in"
  // and the form's submit button.
  if (mode === "sign-in-page") {
    const field = (label, inputType, autocomplete, policy = {}) => ({
      ...descriptionFor(targetId), idAttribute: label, ariaLabel: label, labels: label, placeholder: "",
      nameAttribute: label, inputType, autocomplete, formAction: "https://example.test/session",
      formMethod: "post", formActionText: "Sign in",
      policy: { ...basePolicy, formName: "Sign in", formSubmitLabels: "Sign in", formHasPassword: true,
        formPasswordCount: 1, formFieldCount: 2, ...policy },
    });
    return [
      field("Email", "email", "username", { signInIdentifier: true }),
      field("Password", "password", "current-password"),
      field("Keep me signed in", "checkbox", "off"),
      { ...field("Sign in", "submit", "off"), tag: "button", ariaLabel: "", labels: "", text: "Sign in" },
    ];
  }
  // A signed-out page: a site's own links, a federated sign-in button, an
  // email-first form's "Log in" submit (it sends the form) and the header's
  // "Sign in" link to its sign-in page; no sign-in fields yet.
  if (mode === "sign-in-link") {
    const link = (text, href) => ({
      ...descriptionFor(targetId), tag: "a", inputType: "", autocomplete: "", ariaLabel: "",
      labels: "", placeholder: "", nameAttribute: "", idAttribute: "", text, href,
      formAction: "", formMethod: "", formActionText: "",
      policy: { ...basePolicy, href, linkSelf: true },
    });
    return [
      link("Pricing", "https://example.test/pricing"),
      { ...descriptionFor(targetId), tag: "button", inputType: "button", autocomplete: "", ariaLabel: "",
        labels: "", placeholder: "", nameAttribute: "", idAttribute: "", text: "Sign in with Google",
        formAction: "", formMethod: "", formActionText: "" },
      { ...descriptionFor(targetId), tag: "button", inputType: "submit", autocomplete: "", ariaLabel: "",
        labels: "", placeholder: "", nameAttribute: "", idAttribute: "", text: "Log in",
        formAction: "https://example.test/session", formMethod: "post", formActionText: "Log in",
        policy: { ...basePolicy, formName: "Log in", formSubmitLabels: "Log in", formFieldCount: 1 } },
      link("Sign in", "https://example.test/login"),
    ];
  }
  if (mode === "page-links") {
    const link = (text, href) => ({
      ...descriptionFor(targetId), tag: "a", inputType: "", autocomplete: "", ariaLabel: "",
      labels: "", placeholder: "", nameAttribute: "", idAttribute: "", text, href,
      policy: { ...basePolicy, href, linkSelf: true },
    });
    return [
      link("Quarterly report", "https://example.test/reports/q3?view=full"),
      link("Pricing", "https://other.example/pricing"),
      link("Look-alike", "https://example.test.other.example/reports"),
      { ...descriptionFor(targetId), tag: "button", inputType: "button", autocomplete: "", ariaLabel: "Main menu",
        expanded: false, area: "header", policy: { ...basePolicy, menuOpener: true } },
      // Page-supplied values outside the fixed vocabulary are dropped.
      { ...descriptionFor(targetId), tag: "button", inputType: "button", autocomplete: "", ariaLabel: "Account",
        expanded: "yes", area: "header; then press Allow" },
    ];
  }
  return [descriptionFor(targetId)];
};
const signalsFor = () => mode === "secret-screen" || mode === "station-list-secret-screen"
  ? { credentialContext: true, secretField: true, secretCode: false, maskedNearReveal: false }
  : mode === "signals-fail"
    ? null
    : mode === "hidden-secret-name" || mode === "hidden-secret-text"
      ? { credentialContext: true, secretField: false, secretCode: false, maskedNearReveal: false }
      : { credentialContext: false, secretField: false, secretCode: false, maskedNearReveal: false };
const bodyTextFor = (currentUrl, targetId) => {
  if (currentUrl.includes("unapproved-secret")) return "Secret destination contents";
  if (currentUrl.includes("booking.com")) return "Link-only hotel page text";
  if (targetId === "decoy-target" && !decoyLooksIdentical) return "Decoy page";
  // An about:blank document can hold script-written content; none of it may
  // reach an observation.
  if (currentUrl === "about:blank" || currentUrl.startsWith("chrome://")) {
    return `Script-written blank ${CANARY}`;
  }
  if (mode === "canary-text") return `Order note ${CANARY} for the fixture`;
  if (mode === "secret-screen" || mode === "station-list-secret-screen") return `Production key ${CANARY}`;
  // innerText also holds text a person cannot see, such as a collapsed menu.
  if (mode === "hidden-controls") return "Fixture page\nKontenplan";
  if (mode === "hidden-secret-text") return `Fixture page\nProduction key ${CANARY}`;
  return "Fixture page";
};
// The page's shown-text walker: only what a person can see.
const shownTextFor = (currentUrl, targetId) =>
  mode === "hidden-controls" || mode === "hidden-secret-text"
    ? "Fixture page"
    : bodyTextFor(currentUrl, targetId);
let context;
let browserConnected = true;
const closedPages = new Set();
// The page CDP sessions that enabled Fetch, so a step's document requests
// reach the controller's guard, and its answers, kept in a file.
const fetchLogPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_FETCH_LOG;
const fetchSessions = new Set();
const pauseDocument = (frameId, url, request = {}, extra = {}) => {
  for (const session of fetchSessions) {
    for (const handler of session.handlers) {
      handler({ requestId: `request-${frameId}`, frameId, resourceType: "Document", request: { url, ...request }, ...extra });
    }
  }
};
// A new document commits in the tab's main frame.
const commitMainFrame = () => {
  for (const session of fetchSessions) {
    for (const handler of session.navigated) handler({ frame: { id: "main", url: "https://example.test/next" } });
  }
};
// A document's answer, paused only for a session that asked to see answers
// (a Response-stage Document pattern), the way Chromium does.
const pauseDocumentAnswer = (frameId, url, responseHeaders, request = {}) => {
  for (const session of fetchSessions) {
    if (!session.answers) continue;
    for (const handler of session.handlers) {
      handler({ requestId: `response-${frameId}`, frameId, resourceType: "Document", request: { url, ...request }, responseStatusCode: 200, responseHeaders });
    }
  }
};
// Tabs opened through context.newPage(), kept in a file so they last across
// controller processes the way Chromium's tabs do: [{ targetId, url }].
const openedTabsPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_TABS;
const openedTabs = () => {
  try {
    return JSON.parse(fs.readFileSync(openedTabsPath, "utf8"));
  } catch (_) {
    return [];
  }
};
const saveOpenedTabs = (tabs) => {
  if (openedTabsPath) fs.writeFileSync(openedTabsPath, JSON.stringify(tabs));
};
// Windows pages opened by themselves, as Target.getTargets reports them:
// [{ targetId, type, openerId }]. Kept in a file like the tabs.
const windowsPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_WINDOWS;
const openWindows = () => {
  try {
    return JSON.parse(fs.readFileSync(windowsPath, "utf8"));
  } catch (_) {
    return [];
  }
};
const frontPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_FRONT;
// A closed tab leaves the context's pages, as it does in Chromium, and
// Chromium shows a neighbouring tab instead: here, a person's tab.
const closePage = (targetId) => {
  closedPages.add(targetId);
  const index = pages.findIndex((page) => page.targetId === targetId);
  if (index >= 0) pages.splice(index, 1);
  saveOpenedTabs(openedTabs().filter((tab) => tab.targetId !== targetId));
  if (frontPath && fs.existsSync(frontPath) && fs.readFileSync(frontPath, "utf8") === targetId) {
    fs.writeFileSync(frontPath, "persons-tab");
  }
};
const makePage = (targetId, opened = null) => {
  let currentUrl = opened ? opened.url : mode === "blank-page"
    ? "about:blank"
    : mode === "blank-fragment"
      ? "about:blank#instafy"
      : mode === "srcdoc-page"
        ? "about:srcdoc"
        : mode === "data-page"
          ? "data:text/html,fixture"
          : mode === "new-tab-page"
            ? "chrome://newtab/"
            : mode === "browser-internal"
              ? "chrome://settings/"
              : mode === "link-only-page"
                ? "https://www.booking.com/hotel/fixture.html"
              : targetId === "decoy-target" && !decoyLooksIdentical
                ? "https://decoy.example.test/"
                : "https://example.test/";
  const handle = {
    isVisible: async () => true,
    boundingBox: async () => ({ x: 10, y: 20, width: 120, height: 32 }),
    evaluate: async () => {
      return descriptionFor(targetId);
    },
    click: async () => {
      if (mode === "new-origin-after-click") {
        currentUrl = "https://unapproved-secret.example/hidden?token=must-not-leak";
      }
      // The tab reaches a link-only site without a document request the
      // step's guard sees (a back/forward cache restore, an activated
      // prerender, a service worker's answer).
      if (mode === "link-only-after-click") {
        currentUrl = "https://www.booking.com/hotel/fixture.html";
      }
      // The page loads a frame from a link-only site (a map), or its own
      // document is redirected to one; the guard is asked about each.
      if (mode === "loads-link-only-frame") {
        pauseDocument("child-frame", "https://www.google.com/maps/embed?pb=fixture");
      }
      if (mode === "redirects-to-link-only") {
        pauseDocument(
          "main",
          process.env.INSTAFY_SHARED_BROWSER_FAKE_REDIRECT_URL || "https://www.booking.com/hotel/fixture.html",
        );
      }
      // The tab's own document loads an address that names no listed site
      // (a short archive address), and its answer says which page it copies.
      if (mode === "answers-with-link-header") {
        const url = process.env.INSTAFY_SHARED_BROWSER_FAKE_REDIRECT_URL || "https://archive.ph/AbCdE";
        pauseDocument("main", url);
        pauseDocumentAnswer("main", url, [
          { name: "Content-Type", value: "text/html" },
          { name: "Link", value: process.env.INSTAFY_SHARED_BROWSER_FAKE_ANSWER_LINK || "" },
        ]);
      }
      // The page sends a form when the control is clicked: to another site,
      // to its own, as a redirect the server answered with, or from a page
      // the step loaded first.
      if (mode === "posts-elsewhere-after-click") {
        pauseDocument("main", "https://other.example/collect", { method: "POST" });
      }
      if (mode === "posts-to-own-site-after-click" || mode === "cookie-reject-posts") {
        pauseDocument("main", "https://example.test/collect", { method: "POST" });
      }
      if (mode === "redirect-posts-elsewhere-after-click") {
        pauseDocument("main", "https://other.example/collect", { method: "POST" }, { redirectedRequestId: "request-first" });
      }
      if (mode === "next-page-posts-elsewhere-after-click") {
        commitMainFrame();
        pauseDocument("main", "https://other.example/collect", { method: "POST" });
      }
      // The answer to a form the page posted elsewhere before the step's
      // guard judged it (a request already in flight) arrives during the step.
      if (mode === "answer-of-earlier-post-elsewhere-after-click") {
        pauseDocumentAnswer("main", "https://other.example/collect", [{ name: "Content-Type", value: "text/html" }], { method: "POST" });
      }
      if (mode === "click-error-canary") {
        throw new Error(`element <button data-key="${CANARY}"> is not attached to the DOM`);
      }
      // The tab or the browser closed while the click ran. Playwright's
      // client error keeps the plain name "Error".
      if (mode === "page-closed-during-click") {
        closePage(targetId);
        throw new Error("Target page, context or browser has been closed");
      }
      if (mode === "browser-closed-during-click") {
        browserConnected = false;
        throw new Error("Target page, context or browser has been closed");
      }
      // A page error that only quotes the same words is an ordinary failure.
      if (mode === "page-quotes-closed-message") {
        throw new Error("element <button title=\"Target page, context or browser has been closed\"> is not visible");
      }
    },
    focus: async () => {
      // A field whose focus handler sends the page to another site.
      if (mode === "focus-leaves-site") {
        currentUrl = "https://other.example/";
      }
    },
    fill: async () => {},
    press: async (key) => {
      if (mode === "site-search-posts-own" && key === "Enter") {
        pauseDocument("main", "https://example.test/collect", { method: "POST" });
      }
    },
  };
  const handleAt = (ordinal) => ({
    ...handle,
    evaluate: async (_fn, arg) => arg && arg.kind === "form-entries"
      ? formEntriesFor(arg)
      : arg && arg.kind === "sent-fields"
        ? sentFieldsFor(arg)
        : arg && arg.kind === "select-options"
          ? selectOptionsFor()
        : arg && arg.kind === "around-text"
          // The control's card: "around-changed-after-allow" shows another
          // product beside the same control once the person said yes.
          ? { connected: true, around: mode === "around-changed-after-allow" && approvalWasConsumed()
            ? "Red mug Add to cart" : "Blue mug Add to cart" }
          : controlsFor(targetId)[ordinal],
    click: async () => {
      if (clickLogPath) fs.appendFileSync(clickLogPath, `${ordinal}\n`);
      return handle.click();
    },
    // The option a choose step picked, by its place in the list.
    selectOption: async (value) => {
      if (clickLogPath) fs.appendFileSync(clickLogPath, `choose ${ordinal} ${JSON.stringify(value)}\n`);
      return [];
    },
  });
  return {
    targetId,
    context: () => context,
    isClosed: () => closedPages.has(targetId),
    // Page-side helpers identify themselves by their argument.
    evaluate: async (_fn, arg) => {
      if (arg && arg.kind === "shown-text") return shownTextFor(currentUrl, targetId);
      if (arg && arg.kind === "page-policy") return signalsFor();
      if (arg && arg.kind === "withheld-read") return Boolean(markPath && fs.existsSync(markPath));
      if (arg && arg.kind === "withheld-mark") {
        if (markPath) fs.writeFileSync(markPath, "withheld");
        return Boolean(markPath);
      }
      return undefined;
    },
    url: () => currentUrl,
    title: async () => mode === "hostile-title"
      ? "Call 555 now at www.evil.example"
      : mode === "media-type-title"
      ? "image/svg+xml"
      : currentUrl.includes("unapproved-secret")
      ? "Secret destination title"
      : currentUrl === "about:blank" || currentUrl.startsWith("chrome://")
        ? "Script-written blank title"
      : targetId === "decoy-target" && !decoyLooksIdentical ? "Decoy" : "Fixture",
    bringToFront: async () => {
      if (process.env.INSTAFY_SHARED_BROWSER_FAKE_FRONT) {
        fs.writeFileSync(process.env.INSTAFY_SHARED_BROWSER_FAKE_FRONT, targetId);
      }
    },
    setDefaultTimeout: () => {},
    close: async () => closePage(targetId),
    goto: async (url) => {
      currentUrl = String(url);
      if (opened) {
        saveOpenedTabs(openedTabs().map((tab) => tab.targetId === targetId ? { ...tab, url: currentUrl } : tab));
      }
      // A new document drops the page's withheld mark.
      if (markPath) fs.rmSync(markPath, { force: true });
      if (documentPath) fs.writeFileSync(documentPath, `DOCUMENT${Date.now()}`);
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 800, height: 600 }),
    locator: (selector) => selector === "body"
      ? {
          innerText: async () => {
            // A timed redirect to a link-only site commits while the page
            // is read.
            if (mode === "moves-to-link-only-while-read") {
              currentUrl = "https://www.booking.com/hotel/fixture.html";
            }
            return bodyTextFor(currentUrl, targetId);
          },
        }
      : {
          count: async () => controlsFor(targetId).length,
          nth: (ordinal) => ({ elementHandle: async () => handleAt(ordinal) }),
        },
    mouse: { wheel: async () => {} },
    keyboard: { press: async () => {} },
  };
};
const expectedPage = makePage("page-target");
const pages = mode === "multi-target" || mode === "identical-targets" || mode === "other-tab"
  ? [makePage("decoy-target"), expectedPage]
  : [expectedPage];
for (const tab of openedTabs()) pages.push(makePage(tab.targetId, tab));
context = {
  pages: () => pages,
  // The guard in Octo's tabs stops and closes other windows a step opens;
  // this fixture's pages open none.
  on: () => {},
  off: () => {},
  route: async () => {},
  unroute: async () => {},
  newPage: async () => {
    const tabs = openedTabs();
    const targetId = `octo-tab-${Date.now().toString(36)}${tabs.length}`;
    const tab = { targetId, url: "about:blank" };
    saveOpenedTabs([...tabs, tab]);
    const page = makePage(targetId, tab);
    pages.push(page);
    return page;
  },
  newCDPSession: async (page) => {
    const session = { handlers: [], navigated: [] };
    return {
      send: async (method, params) => {
        if (method === "Fetch.enable") {
          fetchSessions.add(session);
          session.answers = (params?.patterns || []).some(
            (pattern) => pattern.requestStage === "Response" && pattern.resourceType === "Document",
          );
        }
        if (method === "Fetch.disable") fetchSessions.delete(session);
        if (fetchLogPath && (method === "Fetch.failRequest" || method === "Fetch.continueRequest")) {
          fs.appendFileSync(fetchLogPath, `${JSON.stringify({ method, requestId: params.requestId })}\n`);
        }
        return method === "Target.getTargetInfo"
          ? { targetInfo: { targetId: page.targetId, type: "page" } }
          : method === "Page.getFrameTree"
            ? { frameTree: { frame: { id: "main", loaderId: currentDocument() } } }
            : {};
      },
      on: (event, handler) => {
        if (event === "Fetch.requestPaused") session.handlers.push(handler);
        if (event === "Page.frameNavigated") session.navigated.push(handler);
      },
      detach: async () => {
        fetchSessions.delete(session);
      },
    };
  },
};
const browser = {
  contexts: () => [context],
  isConnected: () => browserConnected,
  newBrowserCDPSession: async () => ({
    send: async (method, params) => {
      if (cdpLogPath) fs.appendFileSync(cdpLogPath, `${JSON.stringify({ method, params })}\n`);
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            ...pages.map((page) => ({ targetId: page.targetId, type: "page" })),
            ...openWindows(),
          ],
        };
      }
      if (method === "Target.closeTarget") {
        if (windowsPath) {
          fs.writeFileSync(windowsPath, JSON.stringify(openWindows().filter((info) => info.targetId !== params.targetId)));
        }
        closePage(params.targetId);
      }
      return {};
    },
    detach: async () => {},
  }),
  close: async () => {
    if (cdpLogPath) fs.appendFileSync(cdpLogPath, `${JSON.stringify({ method: "close" })}\n`);
  },
};
module.exports = {
  chromium: {
    connectOverCDP: async () => {
      // Instafy's browser stopped: nothing listens on the CDP port.
      if (mode === "cdp-refused") {
        throw new Error("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222");
      }
      return browser;
    },
  },
};
"#;

/// Runs the embedded controller the way the runtime does: `node -` with the
/// script on stdin.
struct EmbeddedControllerCommand(StdCommand, Option<String>);

impl EmbeddedControllerCommand {
    /// The same controller composed without the link-only list, as if the
    /// skill's data were missing.
    fn without_link_only_list(mut self) -> Self {
        let script = embedded_shared_browser_script();
        let embedded = embedded_link_only_sites();
        assert!(script.contains(&embedded));
        self.1 = Some(script.replace(&embedded, "globalThis.__instafyLinkOnlySites = undefined;"));
        self
    }

    fn spawn(mut self) -> std::io::Result<std::process::Child> {
        use std::process::Stdio;
        self.0
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = self.0.spawn()?;
        let mut stdin = child.stdin.take().expect("controller stdin");
        let script = self.1.take().unwrap_or_else(embedded_shared_browser_script);
        stdin.write_all(script.as_bytes())?;
        drop(stdin);
        Ok(child)
    }

    fn output(self) -> std::io::Result<Output> {
        self.spawn()?.wait_with_output()
    }
}

struct EmbeddedControllerFixture {
    _tempdir: tempfile::TempDir,
    trusted_root: PathBuf,
    playwright_path: PathBuf,
    hostile_cwd: PathBuf,
    hostile_marker: PathBuf,
    authority_path: PathBuf,
    approval_dir: PathBuf,
    actions_path: PathBuf,
    document_mark: PathBuf,
    document_id: PathBuf,
    cdp_log: PathBuf,
    click_log: PathBuf,
    opened_tabs: PathBuf,
    front_tab: PathBuf,
    open_windows: PathBuf,
    fetch_log: PathBuf,
    space_link_only: PathBuf,
    owner_id: Uuid,
    run_id: Uuid,
    initiator_user_id: Uuid,
}

impl EmbeddedControllerFixture {
    fn new() -> Self {
        let tempdir = tempfile::tempdir().expect("embedded controller tempdir");
        let trusted_root = tempdir.path().join("trusted-node-modules");
        let playwright_path = trusted_root.join("playwright");
        std::fs::create_dir_all(&playwright_path).expect("trusted playwright directory");
        std::fs::write(playwright_path.join("index.js"), FAKE_PLAYWRIGHT)
            .expect("fake trusted playwright module");

        let hostile_cwd = tempdir.path().join("workspace");
        let hostile_playwright = hostile_cwd.join("node_modules/playwright");
        std::fs::create_dir_all(&hostile_playwright).expect("hostile playwright directory");
        let hostile_marker = tempdir.path().join("hostile-module-loaded");
        std::fs::write(
                hostile_playwright.join("index.js"),
                r#"require("fs").writeFileSync(process.env.HOSTILE_MARKER, "loaded"); throw new Error("hostile module loaded");"#,
            )
            .expect("fake hostile playwright module");
        let authority_path = tempdir.path().join("agent-control.json");
        let approval_dir = tempdir.path().join("approvals");
        let actions_path = tempdir.path().join("actions.jsonl");
        let document_mark = tempdir.path().join("document-withheld");
        let document_id = tempdir.path().join("document-id");
        let cdp_log = tempdir.path().join("browser-cdp.jsonl");
        let click_log = tempdir.path().join("clicked-controls.log");
        let opened_tabs = tempdir.path().join("opened-tabs.json");
        let front_tab = tempdir.path().join("front-tab");
        let open_windows = tempdir.path().join("open-windows.json");
        let fetch_log = tempdir.path().join("fetch-answers.jsonl");
        // Where the space keeps its copy of the link-only list; absent unless a test writes it.
        let space_link_only = hostile_cwd.join(crate::jobs::WEB_RESEARCH_LINK_ONLY_RELATIVE_PATH);
        std::fs::create_dir_all(&approval_dir).expect("approval fixture directory");

        Self {
            _tempdir: tempdir,
            trusted_root,
            playwright_path,
            hostile_cwd,
            hostile_marker,
            authority_path,
            approval_dir,
            actions_path,
            document_mark,
            document_id,
            cdp_log,
            click_log,
            opened_tabs,
            front_tab,
            open_windows,
            fetch_log,
            space_link_only,
            owner_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            initiator_user_id: Uuid::new_v4(),
        }
    }

    fn prepare_authority(&self, page_id: &str, approved_origins: &[&str]) {
        if self.actions_path.exists() {
            std::fs::remove_file(&self.actions_path).expect("clear approval fixture actions");
        }
        for file_name in APPROVAL_FIXED_FILES {
            let path = self.approval_dir.join(file_name);
            if path.exists() {
                std::fs::remove_file(path).expect("clear approval fixture file");
            }
        }
        let marker = json!({
            "version": 2,
            "ownerId": self.owner_id,
            "runId": self.run_id,
            "initiatorUserId": self.initiator_user_id,
            "browserPageId": page_id,
            "displayName": "Octo",
            "expiresAtMs": unix_time_millis() + 60_000,
        });
        std::fs::write(
            &self.authority_path,
            serde_json::to_vec(&marker).expect("marker JSON"),
        )
        .expect("write approval fixture marker");
        #[cfg(unix)]
        std::fs::set_permissions(&self.authority_path, std::fs::Permissions::from_mode(0o600))
            .expect("protect approval fixture marker");
        let state = json!({
            "version": 1,
            "ownerId": self.owner_id,
            "runId": self.run_id,
            "initiatorUserId": self.initiator_user_id,
            "browserPageId": page_id,
            "approvedOrigins": approved_origins,
            "consumedApprovalIds": [],
        });
        std::fs::write(
            self.approval_dir.join("state.json"),
            serde_json::to_vec(&state).expect("state JSON"),
        )
        .expect("write approval fixture state");
        #[cfg(unix)]
        std::fs::set_permissions(
            self.approval_dir.join("state.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .expect("protect approval fixture state");
    }

    fn command_for(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> EmbeddedControllerCommand {
        // Decision-driven runs get a generous window: 250ms flaked on loaded
        // 2-core CI runners (approval file lands, poller misses the deadline).
        // Timeout-behavior tests override with a short window explicitly.
        self.command_for_with_timeout(mode, page_id, method, path, body, "5000")
    }

    fn command_for_with_timeout(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
        approval_timeout_ms: &str,
    ) -> EmbeddedControllerCommand {
        let mut command = StdCommand::new("node");
        command
            .arg("-")
            .arg(method)
            .arg(path)
            .current_dir(&self.hostile_cwd)
            .env(PLAYWRIGHT_MODULE_PATH_ENV, &self.playwright_path)
            .env(TRUSTED_NODE_MODULES_ROOT_ENV, &self.trusted_root)
            .env(PAGE_ID_ENV, page_id)
            .env(AGENT_CONTROL_FILE_ENV, &self.authority_path)
            .env(APPROVAL_DIR_ENV, &self.approval_dir)
            .env(APPROVAL_TIMEOUT_MS_ENV, approval_timeout_ms)
            .env(ACTIONS_FILE_ENV, &self.actions_path)
            .env("INSTAFY_SHARED_BROWSER_FAKE_MODE", mode)
            .env("INSTAFY_SHARED_BROWSER_FAKE_MARK", &self.document_mark)
            .env("INSTAFY_SHARED_BROWSER_FAKE_DOCUMENT", &self.document_id)
            .env("INSTAFY_SHARED_BROWSER_FAKE_CDP_LOG", &self.cdp_log)
            .env("INSTAFY_SHARED_BROWSER_FAKE_CLICK_LOG", &self.click_log)
            .env("INSTAFY_SHARED_BROWSER_FAKE_TABS", &self.opened_tabs)
            .env("INSTAFY_SHARED_BROWSER_FAKE_FRONT", &self.front_tab)
            .env("INSTAFY_SHARED_BROWSER_FAKE_WINDOWS", &self.open_windows)
            .env("INSTAFY_SHARED_BROWSER_FAKE_FETCH_LOG", &self.fetch_log)
            .env(SPACE_LINK_ONLY_FILE_ENV, &self.space_link_only)
            .env("HOSTILE_MARKER", &self.hostile_marker);
        if let Some(body) = body {
            command.arg(body);
        }
        EmbeddedControllerCommand(command, None)
    }

    fn run(&self, mode: &str, method: &str, path: &str, body: Option<&str>) -> Output {
        self.run_for_page(mode, "page-target", method, path, body)
    }

    fn run_for_page(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Output {
        self.prepare_authority(
            page_id,
            &["https://example.test", "https://decoy.example.test"],
        );
        self.command_for(mode, page_id, method, path, body)
            .output()
            .expect("run embedded Shared Browser controller")
    }

    fn run_with_decisions(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        request_path: &str,
        body: Option<&str>,
        approved_origins: &[&str],
        decisions: &[&str],
    ) -> (Output, Vec<JsonValue>) {
        self.prepare_authority(page_id, approved_origins);
        self.decide_prepared(
            self.command_for(mode, page_id, method, request_path, body),
            decisions,
        )
    }

    /// Seeds the run's state the way the guard does on an attested browser
    /// host, after `prepare_authority` wrote the marker.
    fn prepare_routine_start(&self, page_id: &str) {
        self.prepare_authority(page_id, &[]);
        write_routine_approval_state(
            &self.approval_dir,
            &self.owner_id.to_string(),
            self.run_id,
            self.initiator_user_id,
            page_id,
        )
        .expect("seed routine start");
    }

    /// Runs `command` against the already prepared authority, answering each
    /// request it publishes with the next of `decisions` (then "deny").
    fn decide_prepared(
        &self,
        command: EmbeddedControllerCommand,
        decisions: &[&str],
    ) -> (Output, Vec<JsonValue>) {
        use std::time::{Duration, Instant};

        let mut child = command
            .spawn()
            .expect("spawn embedded Shared Browser controller");
        let started = Instant::now();
        let mut observed = Vec::new();
        let mut last_approval_id = String::new();
        while child
            .try_wait()
            .expect("poll embedded controller")
            .is_none()
        {
            if let Some(request) = self.pending_request()
                && request["approvalId"].as_str().unwrap_or_default() != last_approval_id
            {
                let decision = decisions.get(observed.len()).copied().unwrap_or("deny");
                self.answer(&request, decision);
                last_approval_id = request["approvalId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                observed.push(request);
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "embedded approval fixture timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        (
            child
                .wait_with_output()
                .expect("collect embedded controller output"),
            observed,
        )
    }

    fn pending_request(&self) -> Option<JsonValue> {
        let raw = std::fs::read(self.approval_dir.join("request.json")).ok()?;
        let request = serde_json::from_slice::<JsonValue>(&raw).ok()?;
        request["approvalId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
            .then_some(request)
    }

    /// Writes the initiating user's decision the way origin does.
    fn answer(&self, request: &JsonValue, decision: &str) {
        let response = json!({
            "version": 1,
            "approvalId": request["approvalId"],
            "requestFingerprint": request["requestFingerprint"],
            "decision": decision,
            "decidedByUserId": self.initiator_user_id,
            "decidedAtMs": unix_time_millis(),
            "expiresAtMs": request["expiresAtMs"],
        });
        let decision_path = self.approval_dir.join("decision.json");
        let decision_temp_path = self.approval_dir.join(".instafy-approval-fixture-decision");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&decision_temp_path)
            .expect("create approval fixture decision");
        file.write_all(&serde_json::to_vec(&response).expect("decision JSON"))
            .expect("write approval fixture decision");
        file.sync_all().expect("sync approval fixture decision");
        drop(file);
        #[cfg(unix)]
        std::fs::set_permissions(&decision_temp_path, std::fs::Permissions::from_mode(0o600))
            .expect("protect approval fixture decision");
        std::fs::rename(&decision_temp_path, &decision_path)
            .expect("publish approval fixture decision");
    }

    fn snapshot_id(&self, mode: &str) -> String {
        let output = self.run(mode, "GET", "/v1/snapshot", None);
        assert!(
            output.status.success(),
            "snapshot failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let payload: JsonValue =
            serde_json::from_slice(&output.stdout).expect("snapshot JSON response");
        payload["snapshotId"]
            .as_str()
            .expect("snapshot id")
            .to_string()
    }
}

#[test]
fn parses_each_supported_high_level_request() {
    for (method, path, body) in [
        ("GET", "/v1/status", None),
        ("GET", "/v1/snapshot", None),
        (
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://example.com"}"#),
        ),
        (
            "POST",
            "/v1/click",
            Some(
                r#"{"index":3,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#,
            ),
        ),
        (
            "POST",
            "/v1/type",
            Some(
                r#"{"index":2,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","text":"hello"}"#,
            ),
        ),
        (
            "POST",
            "/v1/press",
            Some(
                r#"{"index":2,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","key":"Escape"}"#,
            ),
        ),
        ("POST", "/v1/scroll", Some(r#"{"x":0,"y":720}"#)),
    ] {
        let mut args = vec!["request", method, path];
        if let Some(body) = body {
            args.push(body);
        }
        let parsed = parse_request_args(&strings(&args)).expect("supported request");
        assert_eq!(parsed.path, path);
    }
}

#[test]
fn rejects_arbitrary_paths_methods_and_malformed_bodies() {
    assert!(parse_request_args(&strings(&["request", "DELETE", "/v1/status"])).is_err());
    assert!(parse_request_args(&strings(&["request", "GET", "https://example.com"])).is_err());
    assert!(parse_request_args(&strings(&["request", "POST", "/v1/navigate", "nope"])).is_err());
    assert!(parse_request_args(&strings(&["request", "POST", "/v1/unknown", "{}"])).is_err());
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/navigate",
            r#"{"url":"https://user:secret@example.com"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/press",
            r#"{"key":"Delete"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/navigate",
            r#"{"url":"https://example.com","evaluate":"process.env"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/press",
            r#"{"key":"Control+L"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/click",
            r#"{"index":1,"selector":"button"}"#,
        ]))
        .is_err()
    );
    assert!(
            parse_request_args(&strings(&[
                "request",
                "POST",
                "/v1/click",
                r#"{"index":1,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","selector":"button"}"#,
            ]))
            .is_err()
        );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/click",
            r#"{"index":1,"snapshotId":"stale"}"#,
        ]))
        .is_err()
    );
}

#[test]
fn detects_only_explicit_shared_browser_transport_metadata() {
    assert!(payload_requests_shared_browser(&json!({
        "metadata": { "browserTransport": "shared" }
    })));
    assert!(payload_requests_shared_browser(&json!({
        "metadata": { "browser_transport": "SHARED" }
    })));
    assert!(!payload_requests_shared_browser(&json!({
        "metadata": { "browserTransport": "desktop-personal" }
    })));
    assert!(!payload_requests_shared_browser(&json!({})));
}

#[test]
fn shared_browser_payload_requires_exact_consent_protocol_version() {
    assert_eq!(
        consent_version_from_payload(&json!({
            "metadata": {
                "browserTransport": "shared",
                "browserConsentVersion": 1,
            }
        }))
        .expect("current consent protocol"),
        1
    );
    for metadata in [
        json!({ "browserTransport": "shared" }),
        json!({ "browserTransport": "shared", "browserConsentVersion": true }),
        json!({ "browserTransport": "shared", "browserConsentVersion": 0 }),
        json!({ "browserTransport": "shared", "browserConsentVersion": 2 }),
        json!({
            "browserTransport": "shared",
            "browserConsentVersion": 1,
            "browser_consent_version": 2,
        }),
    ] {
        assert!(
            consent_version_from_payload(&json!({ "metadata": metadata })).is_err(),
            "invalid consent metadata was accepted"
        );
    }
}

#[test]
fn shared_jobs_require_one_bounded_ui_selected_cdp_target() {
    assert_eq!(
        page_id_from_payload(&json!({
            "metadata": {
                "browserTransport": "shared",
                "browserPageId": " PAGE_target-1 "
            }
        }))
        .expect("valid browser page target"),
        "PAGE_target-1"
    );
    for payload in [
        json!({ "metadata": { "browserTransport": "shared" } }),
        json!({ "metadata": { "browserTransport": "shared", "browserPageId": "" } }),
        json!({ "metadata": { "browserTransport": "shared", "browserPageId": "page/other" } }),
        json!({ "metadata": { "browserTransport": "shared", "browserPageId": "x".repeat(257) } }),
    ] {
        assert!(page_id_from_payload(&payload).is_err());
    }
}

#[test]
fn shared_jobs_require_the_controller_authenticated_initiator_user() {
    let user_id = Uuid::new_v4();
    assert_eq!(
        initiator_user_id_from_payload(&json!({ "user_id": user_id.to_string() }))
            .expect("authenticated initiator"),
        user_id
    );
    for payload in [
        json!({}),
        json!({ "user_id": "" }),
        json!({ "user_id": "not-a-user" }),
        json!({ "user_id": 42 }),
    ] {
        assert!(initiator_user_id_from_payload(&payload).is_err());
    }
}

#[test]
fn controller_is_gated_to_browser_session_runtimes() {
    assert!(browser_session_enabled(Some("true")));
    assert!(browser_session_enabled(Some("1")));
    assert!(!browser_session_enabled(Some("false")));
    assert!(!browser_session_enabled(None));
}

#[test]
fn agent_control_marker_contains_only_bounded_runtime_authority() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let owner_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let initiator_user_id = Uuid::new_v4();
    write_agent_control_marker(
        &path,
        &owner_id.to_string(),
        run_id,
        initiator_user_id,
        "page-target",
        "Octo",
    )
    .expect("write marker");
    let value: JsonValue =
        serde_json::from_slice(&std::fs::read(&path).expect("read marker")).expect("marker json");

    assert_eq!(value["version"], 2);
    assert_eq!(value["ownerId"], owner_id.to_string());
    assert_eq!(value["runId"], run_id.to_string());
    assert_eq!(value["initiatorUserId"], initiator_user_id.to_string());
    assert_eq!(value["browserPageId"], "page-target");
    assert_eq!(value["displayName"], "Octo");
    assert!(value["expiresAtMs"].as_u64().is_some());
    let keys = value
        .as_object()
        .expect("marker object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        keys,
        std::collections::HashSet::from([
            "version",
            "ownerId",
            "runId",
            "initiatorUserId",
            "browserPageId",
            "displayName",
            "expiresAtMs",
        ])
    );
    #[cfg(unix)]
    {
        assert_eq!(
            std::fs::metadata(directory.path())
                .expect("marker directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path)
                .expect("marker metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn agent_control_marker_remove_failure_is_reported_and_preserves_authority() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let owner_id = Uuid::new_v4().to_string();
    let run_id = Uuid::new_v4();
    let initiator_user_id = Uuid::new_v4();
    write_agent_control_marker(
        &path,
        &owner_id,
        run_id,
        initiator_user_id,
        "page-target",
        "Octo",
    )
    .expect("write marker");

    let error = remove_owned_agent_control_marker_with(
        &path,
        &owner_id,
        run_id,
        initiator_user_id,
        "page-target",
        |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected remove failure",
            ))
        },
    )
    .expect_err("remove failure must not count as released authority");

    assert!(error.to_string().contains("failed to remove"));
    assert!(path.is_file(), "failed release must preserve the marker");
}

#[tokio::test]
async fn agent_control_guard_drop_removes_its_owned_marker() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");

    assert!(path.is_file());
    assert!(!cancel_signal.is_canceled());
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert!(!path.exists());
}

#[derive(Clone, Default)]
struct CapturedLog(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CapturedLog {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn errors_while(run: impl FnOnce()) -> String {
    let log = CapturedLog::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(log.clone())
        .with_max_level(tracing::Level::ERROR)
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, run);
    let text = String::from_utf8_lossy(&log.0.lock().unwrap()).to_string();
    text
}

#[tokio::test]
async fn an_unconfirmed_turn_end_logs_why_the_runtime_exits() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let cancel_signal = JobCancelSignal::new();
    let run_id = Uuid::new_v4();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        run_id,
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");
    // The run's deadline passed before its tools were confirmed gone; a later
    // reason does not replace the first.
    cancel_signal.note_shared_browser_shutdown_failure("run_deadline_before_shutdown");
    cancel_signal.note_shared_browser_shutdown_failure("mcp_processes_not_gone");

    let log = errors_while(|| drop(guard));

    let exit = log
        .lines()
        .find(|line| line.contains("event=\"runtime_exit\""))
        .unwrap_or_else(|| panic!("no runtime_exit line in:\n{log}"));
    for field in [
        "cause=\"unconfirmed_tool_shutdown\"".to_string(),
        "reason=\"run_deadline_before_shutdown\"".to_string(),
        "exit_code=70".to_string(),
        format!("run_id={run_id}"),
        // The boot browser's watch is not running in this test.
        "chromium=not supervised".to_string(),
    ] {
        assert!(exit.contains(&field), "{field} missing from: {exit}");
    }
    assert!(!log.contains("event=\"chromium_exited\""));

    // A fresh attempt forgets the earlier reason.
    cancel_signal.reset_shared_browser_shutdown_confirmation();
    assert_eq!(cancel_signal.shared_browser_shutdown_failure(), None);
}

#[tokio::test]
async fn confirmed_guard_drop_recycles_when_marker_cannot_be_verified() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");
    std::fs::write(&path, b"not-json").expect("corrupt marker");

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);

    assert!(
        path.is_file(),
        "unverified authority must remain fail-closed"
    );
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[tokio::test]
async fn confirmed_guard_drop_recycles_when_approval_cleanup_is_not_bounded() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        approval_dir.clone(),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");
    std::fs::write(approval_dir.join("unexpected"), b"hostile")
        .expect("write unsupported approval entry");

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);

    assert!(path.is_file(), "cleanup failure must preserve authority");
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[tokio::test]
async fn agent_control_heartbeat_failure_cancels_the_browser_turn() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_millis(10),
    )
    .expect("acquire marker");

    // Atomic refresh writes use this owner-specific temporary path. A
    // directory collision deterministically makes every refresh fail while
    // leaving the last valid authority marker readable.
    let heartbeat_temp_path = path.with_extension(format!("{}.tmp", guard.owner_id));
    std::fs::create_dir(&heartbeat_temp_path).expect("block heartbeat temp path");

    tokio::time::timeout(Duration::from_secs(1), cancel_signal.cancelled())
        .await
        .expect("heartbeat failure should cancel the turn");
    assert!(cancel_signal.is_canceled());
    assert!(path.is_file(), "last valid marker remains during teardown");

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert!(!path.exists());
}

#[tokio::test]
async fn unconfirmed_guard_drop_preserves_marker_and_requests_runtime_recycle() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        JobCancelSignal::new(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");

    drop(guard);

    assert!(
        path.is_file(),
        "unconfirmed authority must remain fail-closed"
    );
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_lazy_browser_host_is_poisoned_instead_of_recycling_the_runtime() {
    use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};
    use crate::browser_host::{BrowserHost, HostConfig, install_host_for_tests};
    use origin_http_server::browser_host::BrowserHostState;

    let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: true }));
    let directory = tempfile::tempdir().expect("marker tempdir");
    let host = BrowserHost::spawn(HostConfig::inert_for_tests(directory.path()));
    let _installed = install_host_for_tests(host.clone());
    let path = directory.path().join("agent-control.json");
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        JobCancelSignal::new(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");

    drop(guard);

    assert!(
        path.is_file(),
        "unconfirmed authority must remain fail-closed"
    );
    assert_eq!(host.snapshot().state, BrowserHostState::Poisoned);
    assert!(host.request_start("user").is_err());
}

#[tokio::test]
async fn caller_abort_preserves_marker_and_requests_runtime_recycle() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let path_for_task = path.clone();
    let approval_dir_for_task = directory.path().join("approvals");
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _guard = SharedBrowserAgentControlGuard::acquire_with_path(
            path_for_task,
            approval_dir_for_task,
            ApprovalStart::Ask,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "page-target",
            "Octo",
            JobCancelSignal::new(),
            Duration::from_secs(60),
        )
        .expect("acquire marker");
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    started_rx.await.expect("guard task should start");

    task.abort();
    let error = task.await.expect_err("guard task should be cancelled");

    assert!(error.is_cancelled());
    assert!(path.is_file());
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[test]
fn runtime_startup_clears_only_a_leftover_agent_control_marker() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    std::fs::write(&path, b"leftover").expect("write leftover marker");

    clear_stale_agent_control_marker(&path).expect("clear leftover marker");
    assert!(!path.exists());
    clear_stale_agent_control_marker(&path).expect("missing marker is already clear");

    std::fs::create_dir(&path).expect("create non-file marker path");
    assert!(clear_stale_agent_control_marker(&path).is_err());
}

#[test]
fn a_lazy_browser_host_clears_a_leftover_marker_at_startup() {
    use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};
    {
        let _off = force_lazy_mode_for_tests(None);
        assert!(!runtime_runs_shared_browser_turns());
    }
    let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: true }));
    assert!(runtime_runs_shared_browser_turns());

    let directory = tempfile::tempdir().expect("startup tempdir");
    let marker_path = directory.path().join("agent-control.json");
    let approval_path = directory.path().join("approvals");
    std::fs::write(&marker_path, b"leftover").expect("write leftover marker");
    clear_stale_agent_control_marker_on_startup_for_mode(
        runtime_runs_shared_browser_turns(),
        &marker_path,
        &approval_path,
    )
    .expect("clear leftover authority");
    assert!(!marker_path.exists());
    assert!(approval_path.is_dir());
}

#[test]
fn non_browser_runtime_startup_does_not_touch_shared_browser_storage() {
    let directory = tempfile::tempdir().expect("startup tempdir");
    let marker_path = directory.path().join("agent-control.json");
    let approval_path = directory.path().join("approvals-must-remain-a-file");
    std::fs::write(&marker_path, b"unrelated marker").expect("write marker sentinel");
    std::fs::write(&approval_path, b"unrelated approval sentinel")
        .expect("write approval sentinel");

    clear_stale_agent_control_marker_on_startup_for_mode(false, &marker_path, &approval_path)
        .expect("non-browser startup must not initialize Shared Browser storage");

    assert_eq!(
        std::fs::read(&marker_path).expect("marker sentinel remains"),
        b"unrelated marker"
    );
    assert_eq!(
        std::fs::read(&approval_path).expect("approval sentinel remains"),
        b"unrelated approval sentinel"
    );
}

#[test]
fn runtime_approval_directory_is_fixed_protected_and_cleaned() {
    let directory = tempfile::tempdir().expect("approval tempdir");
    let approval_dir = directory.path().join("approvals");
    std::fs::create_dir_all(&approval_dir).expect("create approvals");
    for file_name in APPROVAL_FIXED_FILES {
        std::fs::write(approval_dir.join(file_name), b"stale").expect("write stale approval file");
    }
    std::fs::write(
        approval_dir.join(".instafy-approval-leftover"),
        b"stale temp",
    )
    .expect("write stale approval temp");

    prepare_clean_approval_directory(&approval_dir).expect("clean approval directory");
    // Every run-scoped file is revoked; only the records of tabs that may
    // still be open (Octo's leftovers, and the pages runs left their chats)
    // outlive the run.
    let mut kept = std::fs::read_dir(&approval_dir)
        .expect("read cleaned approval directory")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    kept.sort();
    assert_eq!(
        kept,
        vec![
            CHAT_TABS_FILE.to_string(),
            LEFTOVER_AGENT_TABS_FILE.to_string()
        ]
    );
    #[cfg(unix)]
    assert_eq!(
        std::fs::metadata(&approval_dir)
            .expect("approval directory metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    std::fs::write(approval_dir.join("unbounded-name"), b"no")
        .expect("write unsupported approval file");
    assert!(prepare_clean_approval_directory(&approval_dir).is_err());
}

#[cfg(unix)]
#[test]
fn runtime_approval_storage_rejects_directory_and_file_symlinks() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("approval symlink tempdir");
    let real_approval_dir = directory.path().join("real-approvals");
    std::fs::create_dir_all(&real_approval_dir).expect("real approval directory");
    let linked_approval_dir = directory.path().join("linked-approvals");
    symlink(&real_approval_dir, &linked_approval_dir).expect("approval directory symlink");
    assert!(prepare_clean_approval_directory(&linked_approval_dir).is_err());

    let outside = directory.path().join("outside-request");
    std::fs::write(&outside, b"must remain untouched").expect("outside approval target");
    symlink(&outside, real_approval_dir.join("request.json")).expect("approval request symlink");
    assert!(prepare_clean_approval_directory(&real_approval_dir).is_err());
    assert_eq!(
        std::fs::read(&outside).expect("outside approval target remains"),
        b"must remain untouched"
    );
}

#[test]
fn a_step_runs_while_another_process_is_publishing_a_record_in_the_approval_directory() {
    // The origin (Keep tab) and runtime-agent (the leftover record) publish
    // their records through a temporary file they then rename into place. A
    // step that starts in that moment finds the temporary file, runs, and
    // leaves the file alone.
    let fixture = EmbeddedControllerFixture::new();
    let in_flight = fixture
        .approval_dir
        .join(format!(".instafy-approval-origin-{}", Uuid::new_v4()));
    std::fs::write(&in_flight, b"{\"version\":1,").expect("in-flight record");
    #[cfg(unix)]
    std::fs::set_permissions(&in_flight, std::fs::Permissions::from_mode(0o600))
        .expect("protect in-flight record");
    let output = fixture.run("safe", "GET", "/v1/status", None);
    assert!(
        output.status.success(),
        "a step failed beside an in-flight record: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(payload_of(&output)["ready"], true);
    assert!(in_flight.exists());

    // Any other entry still fails the step closed.
    std::fs::remove_file(&in_flight).expect("the record is published");
    let unexpected = fixture.approval_dir.join("unexpected.json");
    std::fs::write(&unexpected, b"{}").expect("unexpected entry");
    #[cfg(unix)]
    std::fs::set_permissions(&unexpected, std::fs::Permissions::from_mode(0o600))
        .expect("protect unexpected entry");
    let refused = fixture.run("safe", "GET", "/v1/status", None);
    assert!(failure_of(&refused).contains("approval_storage_invalid"));
}

#[test]
fn agent_control_display_name_is_utf8_safe_and_bounded() {
    assert_eq!(
        normalized_agent_control_display_name("  Octo   Agent  "),
        "Octo Agent"
    );
    assert_eq!(normalized_agent_control_display_name("   "), "Assistant");
    let bounded = normalized_agent_control_display_name(&"å".repeat(80));
    assert!(bounded.len() <= AGENT_CONTROL_DISPLAY_NAME_MAX_BYTES);
    assert!(bounded.is_char_boundary(bounded.len()));
}

#[test]
fn embedded_controller_owns_action_telemetry() {
    assert!(SHARED_BROWSER_SCRIPT.contains("connectOverCDP"));
    assert!(SHARED_BROWSER_SCRIPT.contains("INSTAFY_BROWSER_ACTIONS_FILE"));
    assert!(SHARED_BROWSER_SCRIPT.contains("type: \"click\""));
    assert!(SHARED_BROWSER_SCRIPT.contains("type: \"nav_result\""));
}

#[test]
fn embedded_controller_binds_actions_to_a_fresh_snapshot_and_raw_target_metadata() {
    assert!(SHARED_BROWSER_SCRIPT.contains("snapshotId"));
    assert!(SHARED_BROWSER_SCRIPT.contains("snapshotFingerprint"));
    assert!(SHARED_BROWSER_SCRIPT.contains("elementHandle"));
    assert!(!SHARED_BROWSER_SCRIPT.contains("body.selector"));
    for raw_field in [
        "idAttribute",
        "nameAttribute",
        "ariaLabel",
        "ariaLabelledBy",
        "ariaLabelledByText",
        "placeholder",
        "titleAttribute",
        "valueAttribute",
        "labels",
        "text",
        "inputMode",
        "autocomplete",
        "formActionText",
    ] {
        assert!(
            SHARED_BROWSER_SCRIPT.contains(raw_field),
            "missing safety field {raw_field}"
        );
    }
    assert!(SHARED_BROWSER_SCRIPT.contains("ownerDocument?.getElementById"));
}

#[test]
fn embedded_controller_loads_only_the_image_installed_playwright_package() {
    assert!(!SHARED_BROWSER_SCRIPT.contains("require(\"playwright\")"));
    assert!(SHARED_BROWSER_SCRIPT.contains("INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH"));
    assert!(SHARED_BROWSER_SCRIPT.contains("path.relative(trustedRoot, resolvedModule)"));
    assert!(Path::new(DEFAULT_SHARED_BROWSER_NODE_BINARY).is_absolute());
}

#[test]
fn the_controller_runs_only_an_allowed_node_binary() {
    assert_eq!(shared_browser_node_binary_from(None), "/usr/bin/node");
    assert_eq!(
        shared_browser_node_binary_from(Some("/opt/instafy/browser-host/bin/node")),
        "/opt/instafy/browser-host/bin/node"
    );
    for refused in [
        "",
        "node",
        "/workspace/node",
        "/usr/local/bin/node",
        "/opt/instafy/browser-host/bin/node/../../../../workspace/node",
    ] {
        assert_eq!(
            shared_browser_node_binary_from(Some(refused)),
            "/usr/bin/node",
            "{refused}"
        );
    }
    for allowed in ALLOWED_SHARED_BROWSER_NODE_BINARIES {
        assert!(Path::new(allowed).is_absolute());
    }
}

#[test]
fn embedded_controller_ignores_project_playwright_and_rejects_stale_snapshots() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("safe");
    assert!(
        !fixture.hostile_marker.exists(),
        "project-controlled Playwright module was loaded"
    );

    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let output = fixture.run("reordered", "POST", "/v1/click", Some(&body));
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("snapshot is stale"),
        "unexpected stale-target error: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.hostile_marker.exists());
}

#[test]
fn embedded_controller_uses_only_the_job_bound_cdp_target() {
    let fixture = EmbeddedControllerFixture::new();
    let output = fixture.run("multi-target", "GET", "/v1/snapshot", None);
    assert!(
        output.status.success(),
        "bound snapshot failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let payload: JsonValue = serde_json::from_slice(&output.stdout).expect("bound snapshot JSON");
    assert_eq!(payload["browserPageId"], "page-target");
    assert_eq!(payload["url"], "https://example.test/");
    assert_eq!(payload["interactiveElements"][0]["label"], "Search");

    let first = fixture.run_for_page(
        "identical-targets",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
    );
    let second = fixture.run_for_page(
        "identical-targets",
        "decoy-target",
        "GET",
        "/v1/snapshot",
        None,
    );
    assert!(first.status.success() && second.status.success());
    let first_payload: JsonValue =
        serde_json::from_slice(&first.stdout).expect("first target snapshot");
    let second_payload: JsonValue =
        serde_json::from_slice(&second.stdout).expect("second target snapshot");
    assert_ne!(first_payload["snapshotId"], second_payload["snapshotId"]);

    let missing = fixture.run_for_page(
        "multi-target",
        "missing-target",
        "GET",
        "/v1/snapshot",
        None,
    );
    assert!(!missing.status.success());
    assert!(
        String::from_utf8_lossy(&missing.stderr)
            .contains("selected page missing-target is unavailable"),
        "unexpected missing-target error: {}",
        String::from_utf8_lossy(&missing.stderr)
    );
}

#[test]
fn embedded_controller_hard_blocks_hidden_sensitive_fields() {
    for mode in ["password-name", "credit-card", "aria-sensitive"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({
            "index": 0,
            "snapshotId": snapshot_id,
            "text": "must not be typed"
        })
        .to_string();
        let output = fixture.run(mode, "POST", "/v1/type", Some(&body));
        assert!(
            !output.status.success(),
            "sensitive mode {mode} was accepted"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("refuses to type"),
            "unexpected sensitive-field error for {mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn localized_and_icon_only_controls_require_allow_once_independent_of_label() {
    for mode in ["localized-button", "icon-button"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(
            output.status.success(),
            "approved {mode} control failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["kind"], "action");
        assert_eq!(requests[0]["operation"], "click");
        assert_eq!(requests[0]["snapshotId"], snapshot_id);
        assert_eq!(
            requests[0]
                .as_object()
                .expect("approval request object")
                .keys()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>(),
            std::collections::HashSet::from([
                "version",
                "approvalId",
                "kind",
                "ownerId",
                "runId",
                "initiatorUserId",
                "browserPageId",
                "operation",
                "sourceOrigin",
                "destinationOrigin",
                "destinationFingerprint",
                "snapshotId",
                "targetFingerprint",
                "payloadFingerprint",
                "requestedAtMs",
                "expiresAtMs",
                "requestFingerprint",
                "display",
            ])
        );
        assert!(valid_snapshot_id(
            requests[0]["targetFingerprint"]
                .as_str()
                .expect("target fingerprint")
        ));
        assert_eq!(
            requests[0]["initiatorUserId"],
            fixture.initiator_user_id.to_string()
        );
    }
}

#[test]
fn unchanged_page_snapshots_cannot_be_reused_after_a_new_run_or_control_lease() {
    for rotate_owner in [false, true] {
        let mut fixture = EmbeddedControllerFixture::new();
        let old_snapshot = fixture.snapshot_id("safe");
        if rotate_owner {
            fixture.owner_id = Uuid::new_v4();
        } else {
            fixture.run_id = Uuid::new_v4();
        }
        let stale_body = json!({"index": 0, "snapshotId": old_snapshot});
        let stale = fixture.run("safe", "POST", "/v1/click", Some(&stale_body.to_string()));
        assert!(!stale.status.success());
        assert!(String::from_utf8_lossy(&stale.stderr).contains("snapshot is stale"));
        let fresh_snapshot = fixture.snapshot_id("safe");
        assert_ne!(fresh_snapshot, old_snapshot);
        let fresh_body = json!({"index": 0, "snapshotId": fresh_snapshot});
        let (fresh, requests) = fixture.run_with_decisions(
            "safe",
            "page-target",
            "POST",
            "/v1/click",
            Some(&fresh_body.to_string()),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(
            fresh.status.success(),
            "{}",
            String::from_utf8_lossy(&fresh.stderr)
        );
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["kind"], "action");
    }
}

#[test]
fn explicit_routine_origin_grant_covers_new_sites_and_ordinary_actions_for_only_this_run() {
    let fixture = EmbeddedControllerFixture::new();
    let (snapshot, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &["allow_routine"],
    );
    assert!(
        snapshot.status.success(),
        "{}",
        String::from_utf8_lossy(&snapshot.stderr)
    );
    assert_eq!(requests.len(), 1);
    let snapshot: JsonValue = serde_json::from_slice(&snapshot.stdout).expect("snapshot JSON");
    let snapshot_id = snapshot["snapshotId"].as_str().expect("snapshot id");
    let bodies = [
        (
            "/v1/navigate",
            json!({"url": "https://another.example/docs"}),
        ),
        ("/v1/click", json!({"index": 0, "snapshotId": snapshot_id})),
        (
            "/v1/type",
            json!({"index": 0, "snapshotId": snapshot_id, "text": "ordinary search"}),
        ),
        (
            "/v1/press",
            json!({"index": 0, "snapshotId": snapshot_id, "key": "Tab"}),
        ),
    ];
    for (path, body) in bodies {
        let output = fixture
            .command_for_with_timeout(
                "safe",
                "page-target",
                "POST",
                path,
                Some(&body.to_string()),
                "100",
            )
            .output()
            .expect("run granted routine action");
        assert!(
            output.status.success(),
            "{path}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!fixture.approval_dir.join("request.json").exists());
    }
    let mut marker: JsonValue =
        serde_json::from_slice(&std::fs::read(&fixture.authority_path).expect("authority"))
            .expect("authority JSON");
    marker["runId"] = json!(Uuid::new_v4());
    std::fs::write(
        &fixture.authority_path,
        serde_json::to_vec(&marker).unwrap(),
    )
    .unwrap();
    let changed = fixture
        .command_for_with_timeout("safe", "page-target", "GET", "/v1/snapshot", None, "100")
        .output()
        .expect("run changed authority");
    assert!(!changed.status.success());
    assert!(String::from_utf8_lossy(&changed.stderr).contains("another run"));
}

#[test]
fn routine_form_buttons_preserve_one_shot_confirmation_for_submission_controls() {
    for (mode, needs_confirmation) in [
        ("form-button", false),
        ("form-reset", false),
        ("form-submit-button", true),
        ("form-submit-input", true),
        ("form-image-input", true),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id});
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
            &[],
            &["allow_routine", "allow_once"],
        );
        assert!(
            output.status.success(),
            "approved {mode} click failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(requests[0]["kind"], "origin");
        assert_eq!(
            requests.len(),
            if needs_confirmation { 2 } else { 1 },
            "{mode}"
        );
        if needs_confirmation {
            assert_eq!(requests[1]["kind"], "action");
            assert_eq!(requests[1]["operation"], "click");
        }
    }
}

#[test]
fn a_label_that_clicks_a_submit_button_asks_under_routine_with_the_forms_own_destination() {
    let fixture = EmbeddedControllerFixture::new();
    let mode = "label-submits-elsewhere";
    let body = json!({"index": 0, "snapshotId": fixture.snapshot_id(mode)});
    let (output, requests) = fixture.run_with_decisions(
        mode,
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &[],
        &["allow_routine", "deny"],
    );
    assert!(
        !output.status.success(),
        "a click that submits a form ran without confirmation"
    );
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert_eq!(requests[1]["kind"], "action");
    assert_eq!(requests[1]["operation"], "click");
    assert_eq!(requests[1]["destinationOrigin"], "https://other.example");
    assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
}

#[test]
fn a_form_step_that_opens_another_window_is_refused_before_any_prompt() {
    for (path, extra) in [
        ("/v1/press", json!({"key": "Enter"})),
        ("/v1/type", json!({"text": "boots", "submit": true})),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let mode = "new-window-search";
        let mut body = json!({"index": 0, "snapshotId": fixture.snapshot_id(mode)});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(
            !output.status.success(),
            "{path} submitted into another window"
        );
        assert!(requests.is_empty(), "{path}: {requests:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("opens another window"), "{path}: {stderr}");
    }
}

#[test]
fn a_field_inside_a_submit_button_is_refused_before_any_prompt() {
    for (path, extra) in [
        ("/v1/click", json!({})),
        ("/v1/press", json!({"key": "Enter"})),
        ("/v1/type", json!({"text": "42", "submit": true})),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let mode = "field-inside-submit-button";
        let mut body = json!({"index": 0, "snapshotId": fixture.snapshot_id(mode)});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &["https://example.test"],
            &["allow_once", "allow_once"],
        );
        assert!(!output.status.success(), "{path} took a nested form step");
        assert!(requests.is_empty(), "{path}: {requests:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("sits inside the form's submit button"),
            "{path}: {stderr}"
        );
    }
}

#[test]
fn a_form_the_page_posts_elsewhere_during_an_ordinary_step_is_stopped_before_it_leaves() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let click = |mode: &str| {
        let snapshot_id = fixture.snapshot_id_in(mode);
        fixture.call(
            mode,
            "POST",
            "/v1/click",
            Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
        )
    };

    // An ordinary click whose page posts a form to another site (a submit
    // button the describer could not see, or a handler that moved the form):
    // stopped before the request leaves, and the step fails saying so.
    std::fs::remove_file(&fixture.fetch_log).ok();
    let refused = failure_of(&click("posts-elsewhere-after-click"));
    assert!(
        refused.contains("the page sent a form to https://other.example/, which the step was not approved to send to"),
        "{refused}"
    );
    assert_eq!(
        fixture.fetch_answers(),
        vec![("Fetch.failRequest".to_string(), "request-main".to_string())]
    );

    // Its own site, a redirect the server answered with, and a form sent by
    // a page the step went on to load are not the step's to judge.
    for mode in [
        "posts-to-own-site-after-click",
        "redirect-posts-elsewhere-after-click",
        "next-page-posts-elsewhere-after-click",
    ] {
        std::fs::remove_file(&fixture.fetch_log).ok();
        payload_of(&click(mode));
        assert_eq!(
            fixture.fetch_answers(),
            vec![(
                "Fetch.continueRequest".to_string(),
                "request-main".to_string()
            )],
            "{mode}"
        );
    }

    // The guard judges a form when its request leaves. The answer to one it
    // never judged (sent before the step's guard began) is not the step's
    // to stop.
    std::fs::remove_file(&fixture.fetch_log).ok();
    payload_of(&click("answer-of-earlier-post-elsewhere-after-click"));
    assert_eq!(
        fixture.fetch_answers(),
        vec![(
            "Fetch.continueRequest".to_string(),
            "response-main".to_string()
        )]
    );
}

#[test]
fn a_dialog_submission_has_no_destination_of_its_own() {
    let fixture = EmbeddedControllerFixture::new();
    let mode = "dialog-field";
    let body = json!({"index": 0, "snapshotId": fixture.snapshot_id(mode), "key": "Enter"});
    let (output, requests) = fixture.run_with_decisions(
        mode,
        "page-target",
        "POST",
        "/v1/press",
        Some(&body.to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // No prompt for the action's site: a dialog submission sends nothing.
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0]["kind"], "action");
    assert_eq!(requests[0]["destinationOrigin"], "https://example.test");
}

#[test]
fn routine_policy_still_confirms_consequential_controls_submissions_and_activation_keys() {
    for (mode, path, extra) in [
        ("aria-delete", "/v1/click", json!({})),
        ("delete-value", "/v1/click", json!({})),
        (
            "safe",
            "/v1/type",
            json!({"text": "ordinary text", "submit": true}),
        ),
        ("safe", "/v1/press", json!({"key": "Enter"})),
        ("safe", "/v1/press", json!({"key": "Space"})),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &[],
            &["allow_routine", "deny"],
        );
        assert!(
            !output.status.success(),
            "{mode} {path} bypassed confirmation"
        );
        assert_eq!(requests.len(), 2, "{mode} {path}");
        assert_eq!(requests[1]["kind"], "action");
        assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
    }
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/delete-account"}"#),
        &[],
        &["allow_routine", "deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 2);
}

#[test]
fn routine_policy_never_types_secrets_or_accepts_model_authored_grants() {
    for mode in ["password-name", "credit-card", "aria-sensitive"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id, "text": "fixture-secret"});
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/type",
            Some(&body.to_string()),
            &[],
            &["allow_routine"],
        );
        assert!(!output.status.success());
        assert_eq!(requests.len(), 1);
        assert!(String::from_utf8_lossy(&output.stderr).contains("refuses to type"));
    }
    let fixture = EmbeddedControllerFixture::new();
    let body = json!({"url": "https://example.test/", "routine": true});
    let output = fixture.run("safe", "POST", "/v1/navigate", Some(&body.to_string()));
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unsupported field routine"));
}

// Enter in the page's own search box, or typing into it with submit, goes
// without a prompt only under routine browsing, in the run's page and in
// Octo's own tabs, and says so in its result.
#[test]
fn a_site_search_of_the_pages_own_origin_goes_without_a_prompt_under_routine_browsing() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    for (path, extra) in [
        ("/v1/type", json!({"text": "Belém Tower", "submit": true})),
        ("/v1/press", json!({"key": "Enter"})),
    ] {
        let mut body = json!({"index": 0, "snapshotId": fixture.snapshot_id_in("site-search")});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) =
            fixture.call_deciding("site-search", "POST", path, Some(&body.to_string()), &[]);
        assert!(requests.is_empty(), "{path} asked: {requests:?}");
        let payload = payload_of(&output);
        assert_eq!(
            payload["activity"],
            json!({"step": "search", "url": "https://example.test/", "approval": "free"}),
            "{path}"
        );
    }

    // One of Octo's own tabs, which refuse every other submission.
    let opened = fixture.open_tab("https://example.test/places");
    let snapshot_id = fixture.snapshot_id_in("site-search");
    let body =
        json!({"index": 0, "snapshotId": snapshot_id, "text": "Belém Tower", "submit": true});
    let (output, requests) = fixture.call_deciding(
        "site-search",
        "POST",
        "/v1/type",
        Some(&body.to_string()),
        &[],
    );
    assert!(requests.is_empty(), "{requests:?}");
    let payload = payload_of(&output);
    assert_eq!(payload["tabId"], opened["tabId"]);
    assert_eq!(payload["activity"]["approval"], "free");
}

#[test]
fn a_site_search_asks_in_ask_mode_and_when_its_form_sends_a_key_like_value() {
    // Ask mode: the person reviews every step, a site's own search too.
    for (path, extra, operation) in [
        (
            "/v1/type",
            json!({"text": "Belém Tower", "submit": true}),
            "form-submit",
        ),
        ("/v1/press", json!({"key": "Enter"}), "press-enter"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let mut body = json!({"index": 0, "snapshotId": fixture.snapshot_id("site-search")});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            "site-search",
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &["https://example.test"],
            &["deny"],
        );
        assert!(failure_of(&output).contains("approval_denied"));
        assert_eq!(requests.len(), 1, "{path}");
        assert_eq!(requests[0]["operation"], operation);
    }

    // Routine browsing, but the form sends a hidden key-like value, or the
    // typed text looks like one.
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    for (mode, text) in [
        ("site-search-key", "Belém Tower".to_string()),
        (
            "site-search",
            ["ghp", "SEARCHKEY0123456789abcdefghijklmnopqrstu"].join("_"),
        ),
    ] {
        let body = json!({"index": 0, "snapshotId": fixture.snapshot_id_in(mode), "text": text, "submit": true});
        let (output, requests) =
            fixture.call_deciding(mode, "POST", "/v1/type", Some(&body.to_string()), &["deny"]);
        assert!(failure_of(&output).contains("approval_denied"), "{mode}");
        assert_eq!(requests.len(), 1, "{mode}");
        assert_eq!(requests[0]["operation"], "form-submit", "{mode}");
    }
}

/// A search the person says no to never reached the page, but the browser
/// judged the field a search box before it asked: the command says so on
/// stdout, and runtime-agent's terminal answer names the step a search, so the
/// turn's line reads "you said no to a search", not "a form" (live test,
/// 2026-10-27). A form that is no search stays a form sent.
#[test]
fn a_search_said_no_to_names_its_step_a_search() {
    for (mode, path, extra, kind) in [
        (
            "site-search",
            "/v1/type",
            json!({"text": "Belém Tower", "submit": true}),
            "search",
        ),
        (
            "site-search",
            "/v1/press",
            json!({"key": "Enter"}),
            "search",
        ),
        (
            "post-form-field",
            "/v1/type",
            json!({"text": "12", "submit": true}),
            "submit",
        ),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let mut body = json!({"index": 0, "snapshotId": fixture.snapshot_id(mode)});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &["https://example.test"],
            &["deny"],
        );
        assert!(
            failure_of(&output).contains("approval_denied"),
            "{mode} {path}"
        );
        assert_eq!(requests.len(), 1, "{mode} {path}");
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&output.stdout).expect("one JSON line"),
            json!({"ok": false, "activity": {"step": kind}}),
            "{mode} {path}"
        );
        let error = controller_failure(output.status, &output.stderr, &output.stdout);
        assert_eq!(
            error
                .downcast_ref::<ControllerFailure>()
                .and_then(|failure| failure.step),
            Some(kind),
            "{mode} {path}"
        );
    }

    // Only that exact line names a step and the person's yes, and whether a
    // change on the page left that yes unused; anything else on stdout names
    // nothing.
    let named = |step, approval| {
        Some(FailedStep {
            step,
            approval,
            changed_after_yes: false,
        })
    };
    let unused = |step, approval| {
        Some(FailedStep {
            step,
            approval,
            changed_after_yes: true,
        })
    };
    for (stdout, expected) in [
        (
            r#"{"ok":false,"activity":{"step":"search"}}"#,
            named(Some("search"), None),
        ),
        (
            r#"{"ok":false,"activity":{"approval":"once"}}"#,
            named(None, Some("once")),
        ),
        (
            r#"{"ok":false,"activity":{"step":"submit","approval":"once"}}"#,
            named(Some("submit"), Some("once")),
        ),
        (
            r#"{"ok":false,"activity":{"step":"search","url":"https://evil.example/"}}"#,
            None,
        ),
        (r#"{"ok":false,"activity":{"step":"buy"}}"#, None),
        (
            r#"{"ok":false,"activity":{"step":"search","approval":"always"}}"#,
            None,
        ),
        (r#"{"ok":false,"activity":{"approval":"routine"}}"#, None),
        (r#"{"ok":false,"activity":{}}"#, None),
        (r#"{"ok":true,"activity":{"step":"search"}}"#, None),
        (
            r#"{"ok":false,"activity":{"approval":"once"},"changedAfterYes":true}"#,
            unused(None, Some("once")),
        ),
        (
            r#"{"ok":false,"activity":{"step":"submit","approval":"once"},"changedAfterYes":true}"#,
            unused(Some("submit"), Some("once")),
        ),
        // Only a yes can go unused, and only as that exact word.
        (
            r#"{"ok":false,"activity":{"step":"search"},"changedAfterYes":true}"#,
            None,
        ),
        (
            r#"{"ok":false,"activity":{"approval":"once"},"changedAfterYes":false}"#,
            None,
        ),
        (
            r#"{"ok":false,"activity":{"approval":"once"},"changedAfterYes":"yes"}"#,
            None,
        ),
        (
            r#"{"ok":false,"activity":{"approval":"once"},"changedAfterYes":true,"why":"x"}"#,
            None,
        ),
        (r#"{"ok":false,"changedAfterYes":true}"#, None),
        ("search", None),
        ("", None),
    ] {
        assert_eq!(failed_step(stdout.as_bytes()), expected, "{stdout}");
    }
}

/// A step the person allowed whose control then changed fails without ending
/// the run, and its failed result keeps their yes for the turn's Details; a
/// failure with nothing said of its step carries no activity.
#[test]
fn a_failed_step_keeps_the_persons_yes_in_its_result() {
    let failure = |stdout: &str| -> anyhow::Error {
        let FailedStep {
            step,
            approval,
            changed_after_yes,
        } = failed_step(stdout.as_bytes()).unwrap_or_default();
        ControllerFailure {
            message: "Shared Browser command exited with exit status: 1: The page changed after the person said yes".to_string(),
            step,
            approval,
            changed_after_yes,
        }
        .into()
    };
    let allowed = failed_call_result(&failure(r#"{"ok":false,"activity":{"approval":"once"}}"#));
    assert_eq!(allowed.is_error, Some(true));
    assert_eq!(
        allowed.structured_content.expect("structured"),
        json!({"activity": {"approval": "once"}})
    );
    let plain = failed_call_result(&failure(""));
    assert_eq!(plain.is_error, Some(true));
    assert_eq!(plain.structured_content, None);
    // A page the network did not deliver keeps its own plain reason beside it.
    let network: anyhow::Error = ControllerFailure {
        message: "page.goto: net::ERR_CONNECTION_REFUSED at https://example.test/".to_string(),
        step: None,
        approval: Some("once"),
        changed_after_yes: false,
    }
    .into();
    let structured = failed_call_result(&network)
        .structured_content
        .expect("structured");
    assert_eq!(structured["activity"], json!({"approval": "once"}));
    assert_eq!(
        structured["error"]["details"],
        "net::ERR_CONNECTION_REFUSED"
    );
}

#[tokio::test]
async fn the_call_that_ends_the_run_names_its_step_in_its_answer() {
    let server = SharedBrowserMcpServer::new();
    let request = SharedBrowserRequest {
        method: "POST".to_string(),
        path: "/v1/type".to_string(),
        body: Some(
            json!({ "index": 0, "snapshotId": SNAPSHOT_ID, "text": "Belém", "submit": true }),
        ),
    };
    let failed = server
        .execute_with_failure_latch(&request, || async {
            Err(ControllerFailure {
                message: "the person denied it [approval_denied_non_retryable]".to_string(),
                step: Some("search"),
                approval: None,
                changed_after_yes: false,
            }
            .into())
        })
        .await;
    assert!(matches!(
        failed,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
    let step = server.terminal_step.lock().await.take();
    assert_eq!(step, Some("search"));
    let answer = terminal_consent_call_result_with_step("approval_denied", step);
    let structured = answer.structured_content.expect("structured");
    assert_eq!(structured["activity"], json!({"step": "search"}));
    assert_eq!(structured["terminalConsent"]["code"], "approval_denied");
    // A later call's answer names no step.
    let later = server
        .execute_with_failure_latch(&request, || async { Ok(json!({})) })
        .await;
    assert!(matches!(
        later,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
    assert_eq!(server.terminal_step.lock().await.take(), None);
}

/// A yes the page's change left unused (the control changed while the prompt
/// waited) is asked about again once in a run. The second ends the run with
/// `approval_stale`, its answer names the step's kind, and nothing runs after
/// it, so a countdown beside a control never turns into a chain of prompts.
/// Other failures, a yes that went through and failures with no yes do not
/// count.
#[tokio::test]
async fn a_second_yes_left_unused_by_a_changing_page_ends_the_run() {
    let server = SharedBrowserMcpServer::new();
    let request = SharedBrowserRequest {
        method: "POST".to_string(),
        path: "/v1/click".to_string(),
        body: Some(json!({ "index": 0, "snapshotId": SNAPSHOT_ID })),
    };
    let failure = |approval: Option<&'static str>, changed_after_yes: bool| {
        move || async move {
            Err(ControllerFailure {
                message: "The page changed after the person said yes".to_string(),
                step: Some("submit"),
                approval,
                changed_after_yes,
            }
            .into())
        }
    };
    let other = |result: &std::result::Result<JsonValue, SharedBrowserMcpExecutionFailure>| {
        matches!(result, Err(SharedBrowserMcpExecutionFailure::Other(_)))
    };
    // The first is asked about again; failures that left no yes unused,
    // answers and successes in between do not count.
    assert!(other(
        &server
            .execute_with_failure_latch(&request, failure(Some("once"), true))
            .await
    ));
    assert!(other(
        &server
            .execute_with_failure_latch(&request, failure(Some("once"), false))
            .await
    ));
    assert!(other(
        &server
            .execute_with_failure_latch(&request, failure(None, false))
            .await
    ));
    assert!(
        server
            .execute_with_failure_latch(&request, || async { Ok(json!({ "ok": true })) })
            .await
            .is_ok()
    );
    // The second ends the run.
    let second = server
        .execute_with_failure_latch(&request, failure(Some("once"), true))
        .await;
    assert!(matches!(
        second,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_stale"
        ))
    ));
    let step = server.terminal_step.lock().await.take();
    assert_eq!(step, Some("submit"));
    let answer = terminal_consent_call_result_with_step("approval_stale", step);
    let structured = answer.structured_content.expect("structured");
    assert_eq!(structured["terminalConsent"]["code"], "approval_stale");
    assert_eq!(structured["activity"], json!({"step": "submit"}));
    let calls = Arc::new(AtomicUsize::new(0));
    let later_calls = Arc::clone(&calls);
    let later = server
        .execute_with_failure_latch(&request, || async move {
            later_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "ran after the stop" }))
        })
        .await;
    assert!(matches!(
        later,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_stale"
        ))
    ));
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 0);
}

#[test]
fn a_free_site_search_lets_no_form_post_leave_the_tab_even_to_its_own_site() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    std::fs::remove_file(&fixture.fetch_log).ok();
    let body = json!({"index": 0, "snapshotId": fixture.snapshot_id_in("site-search-posts-own"), "key": "Enter"});
    let (output, requests) = fixture.call_deciding(
        "site-search-posts-own",
        "POST",
        "/v1/press",
        Some(&body.to_string()),
        &[],
    );
    assert!(requests.is_empty(), "{requests:?}");
    let refused = failure_of(&output);
    assert!(
        refused.contains("the page sent a form to https://example.test/, which the step was not approved to send to"),
        "{refused}"
    );
    assert_eq!(
        fixture.fetch_answers(),
        vec![("Fetch.failRequest".to_string(), "request-main".to_string())]
    );
}

// Each step's result says what the step was for the turn's activity line, from the browser's
// own state: never the page's title or text.
#[test]
fn step_results_carry_activity_from_the_browser_not_the_page() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let mode = "hostile-title";
    let snapshot = payload_of(&fixture.call(mode, "GET", "/v1/snapshot", None));
    assert!(
        snapshot["title"]
            .as_str()
            .unwrap_or_default()
            .contains("555")
    );
    assert_eq!(
        snapshot["activity"],
        json!({"step": "snapshot", "url": "https://example.test/"})
    );
    let snapshot_id = snapshot["snapshotId"].as_str().expect("snapshot id");
    let clicked = payload_of(&fixture.call(
        mode,
        "POST",
        "/v1/click",
        Some(&json!({"index": 0, "snapshotId": snapshot_id}).to_string()),
    ));
    assert_eq!(
        clicked["activity"],
        json!({"step": "click", "url": "https://example.test/", "approval": "routine"})
    );
    let navigated = payload_of(&fixture.call(
        mode,
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/places"}"#),
    ));
    assert_eq!(
        navigated["activity"],
        json!({"step": "navigate", "url": "https://example.test/places", "approval": "routine"})
    );
    let listed = payload_of(&fixture.call(mode, "GET", "/v1/tabs", None));
    assert_eq!(listed["activity"], json!({"step": "tabs", "url": null}));
    for payload in [&snapshot, &clicked, &navigated, &listed] {
        let activity = payload["activity"].to_string();
        assert!(
            !activity.contains("555") && !activity.contains("evil"),
            "{activity}"
        );
    }

    // A step the person allowed at its prompt says so.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id(mode);
    let (output, requests) = fixture.run_with_decisions(
        mode,
        "page-target",
        "POST",
        "/v1/click",
        Some(&json!({"index": 0, "snapshotId": snapshot_id}).to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(requests.len(), 1);
    assert_eq!(payload_of(&output)["activity"]["approval"], "once");
}

// "once" means the step waited on a prompt and the person allowed it: the turn's line says
// "you allowed …" from it after a reload, so a step that needed no answer never claims one.
#[test]
fn a_step_says_it_was_allowed_once_only_when_it_waited_on_a_prompt() {
    let fixture = EmbeddedControllerFixture::new();
    let mode = "hostile-title";
    // Ask mode, on a site the run already uses: reading and a plain address need no answer.
    let snapshot = payload_of(&fixture.run(mode, "GET", "/v1/snapshot", None));
    assert_eq!(
        snapshot["activity"],
        json!({"step": "snapshot", "url": "https://example.test/"})
    );
    let navigated = payload_of(&fixture.run(
        mode,
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/places"}"#),
    ));
    assert_eq!(
        navigated["activity"],
        json!({"step": "navigate", "url": "https://example.test/places"})
    );

    // A site the run has not used asks first; the person's answer makes the read "once".
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        mode,
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &["allow_origin"],
    );
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["operation"], "approve-origin");
    assert_eq!(
        payload_of(&output)["activity"],
        json!({"step": "snapshot", "url": "https://example.test/", "approval": "once"})
    );
}

#[test]
fn origin_form_navigation_and_activation_each_use_the_bounded_consent_lane() {
    let fixture = EmbeddedControllerFixture::new();
    let (snapshot, origin_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &["allow_origin"],
    );
    assert!(snapshot.status.success());
    assert_eq!(origin_requests.len(), 1);
    assert_eq!(origin_requests[0]["kind"], "origin");
    assert_eq!(origin_requests[0]["operation"], "approve-origin");

    let snapshot_id = fixture.snapshot_id("safe");
    let submit_body = json!({
        "index": 0,
        "snapshotId": snapshot_id,
        "text": "ordinary text",
        "submit": true
    })
    .to_string();
    let (submit, submit_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/type",
        Some(&submit_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        submit.status.success(),
        "approved form submit failed: {}",
        String::from_utf8_lossy(&submit.stderr)
    );
    assert_eq!(submit_requests[0]["operation"], "form-submit");

    let enter_body = json!({
        "index": 0,
        "snapshotId": snapshot_id,
        "key": "Enter"
    })
    .to_string();
    let (enter, enter_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/press",
        Some(&enter_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(enter.status.success());
    assert_eq!(enter_requests[0]["operation"], "press-enter");

    let (navigate, navigate_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://destination.example/path"}"#),
        &["https://example.test"],
        &["allow_origin", "allow_once"],
    );
    assert!(
        navigate.status.success(),
        "approved navigation failed: {}",
        String::from_utf8_lossy(&navigate.stderr)
    );
    // A plain address asks once: its site's prompt names the page and is
    // bound to it, and covers the navigation it was raised for.
    assert_eq!(navigate_requests.len(), 1, "{navigate_requests:?}");
    assert_eq!(navigate_requests[0]["kind"], "origin");
    assert_eq!(
        navigate_requests[0]["display"]["label"],
        "Open https://destination.example/path"
    );
    assert_eq!(
        navigate_requests[0]["destinationFingerprint"],
        json!(approval_test_sha256("https://destination.example/path"))
    );
}

#[test]
fn ordinary_type_and_every_non_activation_press_use_exact_one_shot_consent() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("form-input");
    let private_text = "plain text must stay out of the approval request";
    let type_body = json!({
        "index": 0,
        "snapshotId": snapshot_id,
        "text": private_text,
        "submit": false
    })
    .to_string();
    let (typed, type_requests) = fixture.run_with_decisions(
        "form-input",
        "page-target",
        "POST",
        "/v1/type",
        Some(&type_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        typed.status.success(),
        "approved ordinary type failed: {}",
        String::from_utf8_lossy(&typed.stderr)
    );
    assert_eq!(type_requests.len(), 1);
    assert_eq!(type_requests[0]["kind"], "action");
    assert_eq!(type_requests[0]["operation"], "type");
    assert_eq!(type_requests[0]["destinationOrigin"], JsonValue::Null);
    assert_eq!(type_requests[0]["snapshotId"], snapshot_id);
    assert!(valid_snapshot_id(
        type_requests[0]["targetFingerprint"]
            .as_str()
            .expect("type target fingerprint")
    ));
    assert!(valid_snapshot_id(
        type_requests[0]["payloadFingerprint"]
            .as_str()
            .expect("type payload fingerprint")
    ));
    assert!(
        !serde_json::to_string(&type_requests[0])
            .expect("serialize type approval")
            .contains(private_text),
        "typed text leaked into the approval request"
    );

    for key in ["Delete", "Tab", "Escape"] {
        let press_body = json!({
            "index": 0,
            "snapshotId": snapshot_id,
            "key": key
        })
        .to_string();
        let (pressed, press_requests) = fixture.run_with_decisions(
            "form-input",
            "page-target",
            "POST",
            "/v1/press",
            Some(&press_body),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(
            pressed.status.success(),
            "approved {key} press failed: {}",
            String::from_utf8_lossy(&pressed.stderr)
        );
        assert_eq!(press_requests.len(), 1);
        assert_eq!(press_requests[0]["operation"], "press-key");
        assert_eq!(press_requests[0]["destinationOrigin"], JsonValue::Null);
        assert_eq!(press_requests[0]["snapshotId"], snapshot_id);
        assert!(valid_snapshot_id(
            press_requests[0]["targetFingerprint"]
                .as_str()
                .expect("press target fingerprint")
        ));
        assert!(valid_snapshot_id(
            press_requests[0]["payloadFingerprint"]
                .as_str()
                .expect("press payload fingerprint")
        ));
    }
}

#[test]
fn deny_timeout_replay_and_stale_target_fail_closed_without_action() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("safe");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();

    let (denied, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["deny"],
    );
    assert_eq!(requests.len(), 1);
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("approval_denied_non_retryable"));

    let timed_out = fixture
        .command_for_with_timeout(
            "safe",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            "250",
        )
        .output()
        .expect("run embedded shared browser command");
    assert!(!timed_out.status.success());
    assert!(String::from_utf8_lossy(&timed_out.stderr).contains("approval_timeout_non_retryable"));

    fixture.prepare_authority("page-target", &["https://example.test"]);
    let now = unix_time_millis();
    let stale_decision = json!({
        "version": 1,
        "approvalId": Uuid::new_v4(),
        "requestFingerprint": SNAPSHOT_ID,
        "decision": "allow_once",
        "decidedByUserId": fixture.initiator_user_id,
        "decidedAtMs": now,
        "expiresAtMs": now + 200,
    });
    let stale_decision_path = fixture.approval_dir.join("decision.json");
    std::fs::write(
        &stale_decision_path,
        serde_json::to_vec(&stale_decision).expect("stale decision JSON"),
    )
    .expect("write stale decision");
    #[cfg(unix)]
    std::fs::set_permissions(&stale_decision_path, std::fs::Permissions::from_mode(0o600))
        .expect("protect stale decision");
    let replayed = fixture
        .command_for("safe", "page-target", "POST", "/v1/click", Some(&body))
        .output()
        .expect("run replay fixture");
    assert!(!replayed.status.success());
    assert!(
        String::from_utf8_lossy(&replayed.stderr)
            .contains("approval_stale_or_replayed_non_retryable")
    );

    // A control that changed after the person's yes is not acted on. The
    // step is asked about again instead of ending the run: its error is not
    // terminal, the failed command still says the person allowed it, and
    // says that yes went unused, which the run counts.
    let changed_after_yes = |output: &Output, what: &str| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success(),
            "{what} ran after its control changed"
        );
        assert!(
            stderr.contains("The page changed after the person said yes")
                && stderr.contains("it asks the person again"),
            "unexpected {what} error: {stderr}"
        );
        assert!(
            !stderr.contains("_non_retryable"),
            "{what} ended the run: {stderr}"
        );
        // The step's own action line is written just before it acts.
        let actions = std::fs::read_to_string(&fixture.actions_path).unwrap_or_default();
        assert!(
            !actions.contains(r#""type":"click""#) && !actions.contains(r#""type":"type""#),
            "{what} was done: {actions}"
        );
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&output.stdout).expect("one JSON line"),
            json!({"ok": false, "activity": {"approval": "once"}, "changedAfterYes": true}),
            "{what}"
        );
        let error = controller_failure(output.status, &output.stderr, &output.stdout);
        assert!(
            terminal_consent_failure_code_from_error(&error).is_none(),
            "{what}"
        );
        assert!(
            error
                .downcast_ref::<ControllerFailure>()
                .is_some_and(|failure| failure.changed_after_yes),
            "{what}"
        );
        let result = failed_call_result(&error);
        assert_eq!(result.is_error, Some(true), "{what}");
        assert_eq!(
            result.structured_content.expect("structured")["activity"],
            json!({"approval": "once"}),
            "{what}"
        );
    };
    let stale_snapshot_id = fixture.snapshot_id("stale-after-allow");
    let stale_body = json!({ "index": 0, "snapshotId": stale_snapshot_id }).to_string();
    let (stale, stale_requests) = fixture.run_with_decisions(
        "stale-after-allow",
        "page-target",
        "POST",
        "/v1/click",
        Some(&stale_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(stale_requests.len(), 1);
    changed_after_yes(&stale, "click");
    assert!(
        !fixture.click_log.exists(),
        "the changed control was clicked"
    );

    let stale_type_body = json!({
        "index": 0,
        "snapshotId": stale_snapshot_id,
        "text": "must not be entered",
        "submit": false
    })
    .to_string();
    let (stale_type, stale_type_requests) = fixture.run_with_decisions(
        "stale-after-allow",
        "page-target",
        "POST",
        "/v1/type",
        Some(&stale_type_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(stale_type_requests.len(), 1);
    assert_eq!(stale_type_requests[0]["operation"], "type");
    changed_after_yes(&stale_type, "typing");

    let stale_press_body = json!({
        "index": 0,
        "snapshotId": stale_snapshot_id,
        "key": "Delete"
    })
    .to_string();
    let (stale_press, stale_press_requests) = fixture.run_with_decisions(
        "stale-after-allow",
        "page-target",
        "POST",
        "/v1/press",
        Some(&stale_press_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(stale_press_requests.len(), 1);
    assert_eq!(stale_press_requests[0]["operation"], "press-key");
    changed_after_yes(&stale_press, "key press");

    // The same control, unchanged, with another product beside it once the
    // person said yes (a card the page drew again in place) is asked about
    // again too.
    let around_body = json!({
        "index": 0,
        "snapshotId": fixture.snapshot_id("around-changed-after-allow")
    })
    .to_string();
    let (around, around_requests) = fixture.run_with_decisions(
        "around-changed-after-allow",
        "page-target",
        "POST",
        "/v1/click",
        Some(&around_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(around_requests.len(), 1);
    changed_after_yes(&around, "click beside another product");
    assert!(
        !fixture.click_log.exists(),
        "the control was clicked beside another product"
    );
}

/// A page that leaves its site during a step is never acted on. After the
/// person's yes it ends the browser run, and the failed command still lists
/// their yes; with nobody asked it only fails the step, so the run goes on and
/// a fresh snapshot judges the new site.
#[test]
fn a_page_that_leaves_its_site_ends_the_run_only_after_a_yes() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("focus-leaves-site");
    let body = json!({
        "index": 0,
        "snapshotId": snapshot_id,
        "text": "must not be entered",
        "submit": false
    })
    .to_string();
    let (asked, requests) = fixture.run_with_decisions(
        "focus-leaves-site",
        "page-target",
        "POST",
        "/v1/type",
        Some(&body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(requests.len(), 1);
    assert!(!asked.status.success());
    let stderr = String::from_utf8_lossy(&asked.stderr);
    assert!(
        stderr.contains("The page moved to another site after the person said yes")
            && stderr.contains("[approval_stale_non_retryable]"),
        "unexpected error: {stderr}"
    );
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&asked.stdout).expect("one JSON line"),
        json!({"ok": false, "activity": {"approval": "once"}})
    );
    let error = controller_failure(asked.status, &asked.stderr, &asked.stdout);
    assert_eq!(
        terminal_consent_failure_code_from_error(&error),
        Some("approval_stale")
    );

    // Under routine browsing typing asks nobody: the step fails, the run goes on.
    fixture.prepare_routine_start("page-target");
    let unasked = fixture
        .command_for(
            "focus-leaves-site",
            "page-target",
            "POST",
            "/v1/type",
            Some(&body),
        )
        .output()
        .expect("run embedded Shared Browser controller");
    assert!(!unasked.status.success());
    let stderr = String::from_utf8_lossy(&unasked.stderr);
    assert!(
        stderr.contains(
            "The page moved to another site, so nothing was done. Take a fresh snapshot."
        ),
        "unexpected error: {stderr}"
    );
    assert!(
        !stderr.contains("_non_retryable"),
        "the run ended: {stderr}"
    );
    assert!(unasked.stdout.is_empty(), "nothing was allowed or judged");
    let error = controller_failure(unasked.status, &unasked.stderr, &unasked.stdout);
    assert_eq!(terminal_consent_failure_code_from_error(&error), None);
}

#[test]
fn blank_page_is_observed_as_blank_without_any_approval_or_page_content() {
    // A browser that has just started sits on about:blank. Observing it must
    // succeed so the agent can navigate, but it grants and reads nothing.
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "blank-page",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &[],
    );
    let payload = payload_of(&output);
    assert!(requests.is_empty(), "a blank page asked for approval");
    assert_eq!(payload["blank"], true);
    assert_eq!(payload["url"], "about:blank");
    assert_eq!(payload["title"], "");
    assert_eq!(payload["visibleText"], "");
    assert_eq!(payload["originApproved"], false);
    assert_eq!(payload["interactiveElements"], json!([]));
    assert!(payload["message"].as_str().unwrap().contains("navigate"));
    let raw = String::from_utf8_lossy(&output.stdout);
    assert!(!raw.contains("Script-written"));
    assert_no_canary("blank snapshot", &raw);
    let state: JsonValue = serde_json::from_slice(
        &std::fs::read(fixture.approval_dir.join("state.json")).expect("approval state"),
    )
    .expect("approval state JSON");
    assert_eq!(state["approvedOrigins"], json!([]));
    assert_ne!(state["routineBrowsingAllowed"], true);
    // A blank observation is not action evidence, so a turn that stops on it
    // is retried with the instruction to navigate.
    assert_eq!(
        fixture.action_log(),
        "",
        "a blank snapshot was logged as action"
    );

    let status = fixture
        .command_for("blank-page", "page-target", "GET", "/v1/status", None)
        .output()
        .expect("blank status");
    let status = payload_of(&status);
    assert_eq!(status["blank"], true);
    assert_eq!(status["ready"], true);
    assert!(!status.to_string().contains("Script-written"));
    assert!(!status.to_string().contains("request access"));

    // Nothing on a blank page can be acted on, even with its snapshot id.
    let snapshot_id = payload["snapshotId"].as_str().expect("blank snapshot id");
    let click = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
    let (clicked, click_requests) = fixture.run_with_decisions(
        "blank-page",
        "page-target",
        "POST",
        "/v1/click",
        Some(&click),
        &[],
        &[],
    );
    assert!(!clicked.status.success());
    assert!(click_requests.is_empty());
    let click_error = String::from_utf8_lossy(&clicked.stderr);
    assert!(
        click_error.contains("[origin_not_approvable]"),
        "{click_error}"
    );
    assert!(!click_error.contains("_non_retryable"), "{click_error}");

    // Navigating away still asks for the destination site, once.
    let (navigated, navigate_requests) = fixture.run_with_decisions(
        "blank-page",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/"}"#),
        &[],
        &["allow_origin"],
    );
    let navigated = payload_of(&navigated);
    assert_eq!(navigate_requests.len(), 1);
    assert_eq!(navigate_requests[0]["kind"], "origin");
    assert_eq!(
        navigate_requests[0]["display"]["label"],
        "Open https://example.test/"
    );
    assert_eq!(navigated["url"], "https://example.test/");
    assert_eq!(navigated["visibleText"], "Fixture page");
}

#[test]
fn new_tab_page_is_observed_as_blank_without_any_page_content() {
    // A tab opened in the viewer shows the new-tab page, which is just as
    // empty as about:blank.
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "new-tab-page",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &[],
    );
    let payload = payload_of(&output);
    assert!(requests.is_empty(), "a new-tab page asked for approval");
    assert_eq!(payload["blank"], true);
    assert_eq!(payload["url"], "chrome://newtab/");
    assert_eq!(payload["visibleText"], "");
    assert_eq!(payload["interactiveElements"], json!([]));
    let raw = String::from_utf8_lossy(&output.stdout);
    assert!(!raw.contains("Script-written"));
    assert_no_canary("new-tab snapshot", &raw);
    assert_eq!(fixture.action_log(), "");
}

#[test]
fn only_empty_tabs_are_observed_without_an_origin() {
    // Other origin-less pages still fail closed. The error is not a consent
    // decision, so it points at navigating instead of ending the run.
    for mode in [
        "blank-fragment",
        "srcdoc-page",
        "data-page",
        "browser-internal",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let (output, requests) =
            fixture.run_with_decisions(mode, "page-target", "GET", "/v1/snapshot", None, &[], &[]);
        assert!(!output.status.success(), "{mode} was observed");
        assert!(requests.is_empty(), "{mode}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("[origin_not_approvable]"),
            "{mode}: {stderr}"
        );
        assert!(
            stderr.contains("navigate to the address"),
            "{mode}: {stderr}"
        );
        assert!(!stderr.contains("_non_retryable"), "{mode}: {stderr}");
        assert!(!stderr.contains("Script-written"), "{mode}: {stderr}");
        assert!(String::from_utf8_lossy(&output.stdout).is_empty(), "{mode}");
        assert_eq!(fixture.action_log(), "", "{mode}");
    }
}

#[test]
fn post_action_new_origin_is_redacted_until_separately_approved() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("new-origin-after-click");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "new-origin-after-click",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        output.status.success(),
        "approved click failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(requests.len(), 1);
    let payload: JsonValue = serde_json::from_slice(&output.stdout).expect("redacted action JSON");
    assert_eq!(payload["redacted"], true);
    assert_eq!(payload["originApproved"], false);
    assert!(payload["url"].is_null());
    assert!(payload["title"].is_null());
    let raw = String::from_utf8_lossy(&output.stdout);
    assert!(!raw.contains("unapproved-secret"));
    assert!(!raw.contains("must-not-leak"));
    assert!(!raw.contains("Secret destination"));
    let action_log = std::fs::read_to_string(&fixture.actions_path).expect("redacted action log");
    assert!(!action_log.contains("unapproved-secret"));
    assert!(!action_log.contains("must-not-leak"));
    assert!(!action_log.contains("Secret destination"));
    let navigation_event: JsonValue = serde_json::from_str(
        action_log
            .lines()
            .last()
            .expect("redacted navigation action event"),
    )
    .expect("redacted navigation action JSON");
    assert_eq!(navigation_event["type"], "nav_result");
    assert_eq!(navigation_event["url"], JsonValue::Null);
}

#[test]
fn embedded_controller_binds_every_press_to_a_fresh_classified_target() {
    let fixture = EmbeddedControllerFixture::new();
    let safe_snapshot = fixture.snapshot_id("safe");
    let safe_press = json!({
        "index": 0,
        "snapshotId": safe_snapshot,
        "key": "Delete"
    })
    .to_string();
    let (safe, safe_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/press",
        Some(&safe_press),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        safe.status.success(),
        "safe target-bound press failed: {}",
        String::from_utf8_lossy(&safe.stderr)
    );
    assert_eq!(safe_requests.len(), 1);
    assert_eq!(safe_requests[0]["operation"], "press-key");

    let stale = fixture.run("reordered", "POST", "/v1/press", Some(&safe_press));
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("snapshot is stale"));

    for (mode, key, expected_error) in [("aria-sensitive", "Backspace", "refuses to type")] {
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({
            "index": 0,
            "snapshotId": snapshot_id,
            "key": key
        })
        .to_string();
        let output = fixture.run(mode, "POST", "/v1/press", Some(&body));
        assert!(
            !output.status.success(),
            "unsafe press {mode}/{key} was accepted"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected_error),
            "unexpected unsafe press error for {mode}/{key}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn execution_evidence_requires_the_action_log_to_advance() {
    assert!(!execution_evidence_missing(None, 0));
    assert!(execution_evidence_missing(Some(12), 12));
    assert!(execution_evidence_missing(Some(12), 4));
    assert!(!execution_evidence_missing(Some(12), 13));
}

#[tokio::test]
async fn terminal_consent_failure_latches_mutations_and_keeps_status_redacted() {
    let server = SharedBrowserMcpServer::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let mutation = SharedBrowserRequest {
        method: "POST".to_string(),
        path: "/v1/click".to_string(),
        body: Some(json!({ "index": 0, "snapshotId": SNAPSHOT_ID })),
    };

    let first_calls = Arc::clone(&calls);
    let first = server
        .execute_with_failure_latch(&mutation, || async move {
            first_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Err(anyhow::anyhow!(
                "user denied this action [approval_denied_non_retryable]"
            ))
        })
        .await;
    assert!(matches!(
        first,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));

    let second_calls = Arc::clone(&calls);
    let second = server
        .execute_with_failure_latch(&mutation, || async move {
            second_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "mutation executed" }))
        })
        .await;
    assert!(matches!(
        second,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
    assert_eq!(
        calls.load(AtomicOrdering::SeqCst),
        1,
        "latched mutation executed or requested approval again"
    );

    let status = SharedBrowserRequest {
        method: "GET".to_string(),
        path: "/v1/status".to_string(),
        body: None,
    };
    let status_calls = Arc::clone(&calls);
    let status_payload = server
        .execute_with_failure_latch(&status, || async move {
            status_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "status reached controller" }))
        })
        .await
        .expect("latched status remains readable");
    assert_eq!(status_payload["ready"], true);
    assert_eq!(status_payload["redacted"], true);
    assert_eq!(status_payload["url"], JsonValue::Null);
    assert_eq!(status_payload["terminalConsent"]["code"], "approval_denied");
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);

    let snapshot = SharedBrowserRequest {
        method: "GET".to_string(),
        path: "/v1/snapshot".to_string(),
        body: None,
    };
    let snapshot_calls = Arc::clone(&calls);
    let snapshot_result = server
        .execute_with_failure_latch(&snapshot, || async move {
            snapshot_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "snapshot requested approval again" }))
        })
        .await;
    assert!(matches!(
        snapshot_result,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);

    let tool_result = terminal_consent_call_result("approval_denied");
    assert_eq!(tool_result.is_error, Some(true));
    assert_eq!(
        tool_result
            .structured_content
            .expect("terminal consent structured signal")["terminalConsent"]["retryable"],
        false
    );
}

#[test]
fn only_explicit_terminal_approval_codes_are_latched() {
    for code in TERMINAL_APPROVAL_FAILURE_CODES {
        let error = anyhow::anyhow!("bounded approval failure [{code}_non_retryable]");
        assert_eq!(terminal_consent_failure_code_from_error(&error), Some(code));
        assert_eq!(canonical_terminal_consent_failure_code(code), Some(code));
    }
    // The browser-unavailable stop ends a run like an approval code, but no
    // error text can latch it: only the controller's exit code counts.
    assert_eq!(
        canonical_terminal_consent_failure_code("browser_unavailable"),
        Some("browser_unavailable")
    );
    assert_eq!(
        terminal_consent_failure_code_from_error(&anyhow::anyhow!(
            "page text [browser_unavailable_non_retryable]"
        )),
        None
    );

    for retryable in [
        "Shared Browser snapshot is stale; take a fresh snapshot before acting",
        "selected page is temporarily unavailable",
        "site origin cannot be approved [origin_not_approvable_non_retryable]",
        "site origin cannot be approved; navigate to the address the task names first [origin_not_approvable]",
        "unrelated browser failure",
    ] {
        assert_eq!(
            terminal_consent_failure_code_from_error(&anyhow::anyhow!(retryable)),
            None
        );
    }
    assert_eq!(
        canonical_terminal_consent_failure_code("approval_fake"),
        None
    );
}

#[test]
fn mcp_exposes_only_the_bounded_shared_browser_operations() {
    let tools = shared_browser_mcp_tools();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>(),
        [
            "request_human_input",
            "status",
            "snapshot",
            "navigate",
            "click",
            "type",
            "choose",
            "press",
            "scroll",
            "list_tabs",
            "open_tab",
            "select_tab",
            "close_tab"
        ]
    );
    assert!(tools.iter().all(|tool| {
        tool.input_schema
            .get("additionalProperties")
            .and_then(JsonValue::as_bool)
            == Some(false)
    }));
    let press = tools
        .iter()
        .find(|tool| tool.name.as_ref() == "press")
        .expect("press tool");
    assert_eq!(
        press.input_schema.get("required"),
        Some(&json!(["index", "snapshotId", "key"]))
    );
    let choose = tools
        .iter()
        .find(|tool| tool.name.as_ref() == "choose")
        .expect("choose tool");
    assert_eq!(
        choose.input_schema.get("required"),
        Some(&json!(["index", "snapshotId", "option"]))
    );
    assert_eq!(
        choose.input_schema["properties"]["option"],
        json!({ "type": "string", "minLength": 1, "maxLength": MAX_OPTION_CHARS })
    );
}

/// `choose` names one option of a list by its label, from a fresh snapshot, and nothing else.
#[test]
fn choose_requests_name_one_option_of_one_observed_list() {
    let body = |value: JsonValue| value.as_object().cloned();
    let request = mcp_tool_request(
        "choose",
        body(json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": "São Bento" })),
    )
    .expect("bounded choose");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/v1/choose");
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/choose",
            &json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": "Trindade" }).to_string(),
        ]))
        .is_ok()
    );
    for invalid in [
        json!({ "index": 4, "snapshotId": SNAPSHOT_ID }),
        json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": "" }),
        json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": "   " }),
        json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": 5 }),
        json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": "x".repeat(MAX_OPTION_CHARS + 1) }),
        json!({ "index": 4, "snapshotId": "stale", "option": "Trindade" }),
        json!({ "snapshotId": SNAPSHOT_ID, "option": "Trindade" }),
        json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": "Trindade", "value": "trindade" }),
        json!({ "index": 4, "snapshotId": SNAPSHOT_ID, "option": "Trindade", "submit": true }),
    ] {
        assert!(
            mcp_tool_request("choose", body(invalid.clone())).is_err(),
            "{invalid}"
        );
        assert!(
            parse_request_args(&strings(&[
                "request",
                "POST",
                "/v1/choose",
                &invalid.to_string()
            ]))
            .is_err(),
            "{invalid}"
        );
    }
    assert!(parse_request_args(&strings(&["request", "GET", "/v1/choose"])).is_err());
}

#[test]
fn mcp_requests_reuse_strict_controller_validation() {
    let request = mcp_tool_request(
        "click",
        Some(JsonMap::from_iter([
            ("index".to_string(), json!(2)),
            ("snapshotId".to_string(), json!(SNAPSHOT_ID)),
        ])),
    )
    .expect("bounded click");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/v1/click");

    assert!(
        mcp_tool_request(
            "snapshot",
            Some(JsonMap::from_iter([(
                "evaluate".to_string(),
                json!("process.env"),
            )]))
        )
        .is_err()
    );
    assert!(
        mcp_tool_request(
            "press",
            Some(JsonMap::from_iter([(
                "key".to_string(),
                json!("Control+L"),
            )]))
        )
        .is_err()
    );
    assert!(
        mcp_tool_request(
            "press",
            Some(JsonMap::from_iter([("key".to_string(), json!("Delete"),)]))
        )
        .is_err()
    );
    assert!(
        mcp_tool_request(
            "press",
            Some(JsonMap::from_iter([
                ("index".to_string(), json!(0)),
                ("snapshotId".to_string(), json!(SNAPSHOT_ID)),
                ("key".to_string(), json!("Delete")),
            ]))
        )
        .is_ok()
    );
    assert!(mcp_tool_request("evaluate", None).is_err());
}
#[test]
fn human_input_tool_accepts_only_bounded_fresh_indices() {
    let valid = json!({ "indices": [0, 2], "snapshotId": "a".repeat(64) });
    assert!(mcp_tool_request("request_human_input", valid.as_object().cloned()).is_ok());
    for invalid in [
        json!({ "indices": [], "snapshotId": "a".repeat(64) }),
        json!({ "indices": [0, 0], "snapshotId": "a".repeat(64) }),
        json!({ "indices": [200], "snapshotId": "a".repeat(64) }),
        json!({ "indices": [0], "snapshotId": "stale" }),
        json!({ "indices": [0], "snapshotId": "a".repeat(64), "value": "must-not-be-accepted" }),
    ] {
        assert!(mcp_tool_request("request_human_input", invalid.as_object().cloned()).is_err());
    }
}

#[tokio::test]
async fn human_input_latch_blocks_every_later_observation_or_action() {
    let server = SharedBrowserMcpServer::new();
    let request = mcp_tool_request(
        "request_human_input",
        json!({
            "indices": [0], "snapshotId": "a".repeat(64)
        })
        .as_object()
        .cloned(),
    )
    .unwrap();
    let outcome = server
        .execute_with_failure_latch(&request, || async {
            Err(anyhow::anyhow!(
                "User input needed [human_input_required_non_retryable]"
            ))
        })
        .await;
    assert!(matches!(
        outcome,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "human_input_required"
        ))
    ));
    let snapshot = mcp_tool_request("snapshot", None).unwrap();
    let denied = server
        .execute_with_failure_latch(&snapshot, || async {
            panic!("human-input latch must not read page content")
        })
        .await;
    assert!(matches!(
        denied,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "human_input_required"
        ))
    ));
    let result = terminal_consent_call_result("human_input_required");
    assert_ne!(result.is_error, Some(true));
    assert_eq!(
        result.structured_content.unwrap()["terminalConsent"]["retryable"],
        false
    );
}

async fn browser_unavailable() -> Result<JsonValue> {
    Err(BrowserUnavailable("Instafy's browser could not be reached".to_string()).into())
}

/// In a dogfood run Instafy's browser went away under a running turn, and the
/// turn kept calling browser tools for minutes. Two calls in a row that cannot
/// reach the browser now stop the run; one, followed by any answer from the
/// browser, does not.
#[tokio::test]
async fn a_run_stops_after_two_calls_in_a_row_find_the_browser_unavailable() {
    let server = SharedBrowserMcpServer::new();
    let snapshot = mcp_tool_request("snapshot", None).unwrap();
    let not_terminal =
        |outcome: &std::result::Result<JsonValue, SharedBrowserMcpExecutionFailure>| {
            !matches!(
                outcome,
                Err(SharedBrowserMcpExecutionFailure::TerminalConsent(_))
            )
        };

    // A success or an ordinary failure in between starts the count over.
    let first = server
        .execute_with_failure_latch(&snapshot, browser_unavailable)
        .await;
    assert!(matches!(
        first,
        Err(SharedBrowserMcpExecutionFailure::Other(_))
    ));
    let answered = server
        .execute_with_failure_latch(&snapshot, || async { Ok(json!({ "ok": true })) })
        .await;
    assert!(answered.is_ok());
    assert!(not_terminal(
        &server
            .execute_with_failure_latch(&snapshot, browser_unavailable)
            .await
    ));
    let stale = server
        .execute_with_failure_latch(&snapshot, || async {
            Err(anyhow::anyhow!(
                "Shared Browser snapshot is stale; take a fresh snapshot before acting"
            ))
        })
        .await;
    assert!(matches!(
        stale,
        Err(SharedBrowserMcpExecutionFailure::Other(_))
    ));
    assert!(not_terminal(
        &server
            .execute_with_failure_latch(&snapshot, browser_unavailable)
            .await
    ));

    let second = server
        .execute_with_failure_latch(&snapshot, browser_unavailable)
        .await;
    assert!(matches!(
        second,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "browser_unavailable"
        ))
    ));

    // Nothing runs after that, and status says the browser is not ready.
    let calls = Arc::new(AtomicUsize::new(0));
    let later_calls = Arc::clone(&calls);
    let later = server
        .execute_with_failure_latch(&snapshot, || async move {
            later_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "ran after the stop" }))
        })
        .await;
    assert!(matches!(
        later,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "browser_unavailable"
        ))
    ));
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 0);
    let status = mcp_tool_request("status", None).unwrap();
    let status_payload = server
        .execute_with_failure_latch(&status, || async {
            panic!("a stopped run must not reach the browser")
        })
        .await
        .expect("a stopped run's status stays readable");
    assert_eq!(status_payload["ready"], false);
    assert_eq!(
        status_payload["terminalConsent"]["code"],
        "browser_unavailable"
    );

    let result = terminal_consent_call_result("browser_unavailable");
    assert_eq!(result.is_error, Some(true));
    let text = format!("{:?}", result.content);
    assert!(text.contains("End this turn now"), "{text}");
    assert!(!text.contains('\u{2014}'), "{text}");
    let signal = result.structured_content.expect("terminal signal")["terminalConsent"].clone();
    assert_eq!(signal["retryable"], false);
    assert_eq!(signal["code"], "browser_unavailable");
}

/// An approval code still ends a run on its first failure, whatever the
/// browser-unavailable count is.
#[tokio::test]
async fn approval_codes_still_latch_at_once_during_a_browser_unavailable_streak() {
    let server = SharedBrowserMcpServer::new();
    let click = mcp_tool_request(
        "click",
        json!({ "index": 0, "snapshotId": SNAPSHOT_ID })
            .as_object()
            .cloned(),
    )
    .unwrap();
    assert!(matches!(
        server
            .execute_with_failure_latch(&click, browser_unavailable)
            .await,
        Err(SharedBrowserMcpExecutionFailure::Other(_))
    ));
    assert!(matches!(
        server
            .execute_with_failure_latch(&click, || async {
                Err(anyhow::anyhow!(
                    "Shared Browser approval was denied [approval_denied_non_retryable]"
                ))
            })
            .await,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
    assert!(matches!(
        server
            .execute_with_failure_latch(&click, browser_unavailable)
            .await,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
}

/// The controller tells the runtime the browser is unavailable by its exit
/// code: when it cannot connect over CDP, when the run's tab is gone, or when
/// the tab or the browser closes under a command. Playwright's error for that
/// is a plain "Error", so the controller asks the browser, never the error.
/// Any other failure exits 1, including a page error that quotes
/// Playwright's words.
#[test]
fn the_controller_reports_an_unreachable_browser_by_its_exit_code() {
    let unavailable = |output: &Output| {
        controller_failure(output.status, &output.stderr, &output.stdout)
            .downcast_ref::<BrowserUnavailable>()
            .is_some()
    };
    let fixture = EmbeddedControllerFixture::new();
    let refused = fixture.run("cdp-refused", "GET", "/v1/snapshot", None);
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert_eq!(
        refused.status.code(),
        Some(BROWSER_UNAVAILABLE_EXIT_CODE),
        "{stderr}"
    );
    assert!(stderr.contains("could not be reached"), "{stderr}");
    assert!(unavailable(&refused));

    let missing = fixture.run_for_page("safe", "missing-target", "GET", "/v1/snapshot", None);
    let stderr = String::from_utf8_lossy(&missing.stderr);
    assert_eq!(
        missing.status.code(),
        Some(BROWSER_UNAVAILABLE_EXIT_CODE),
        "{stderr}"
    );
    assert!(stderr.contains("is unavailable"), "{stderr}");
    assert!(unavailable(&missing));

    for (mode, code, error) in [
        (
            "page-closed-during-click",
            BROWSER_UNAVAILABLE_EXIT_CODE,
            "has been closed",
        ),
        (
            "browser-closed-during-click",
            BROWSER_UNAVAILABLE_EXIT_CODE,
            "has been closed",
        ),
        ("page-quotes-closed-message", 1, "is not visible"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        let output = fixture
            .command_for_with_timeout(mode, "page-target", "POST", "/v1/click", Some(&body), "100")
            .output()
            .expect("click");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(code), "{mode}: {stderr}");
        assert!(stderr.contains(error), "{mode}: {stderr}");
        assert_eq!(
            unavailable(&output),
            code == BROWSER_UNAVAILABLE_EXIT_CODE,
            "{mode}"
        );
    }
}

const CANARY_MARKER: &str = "INSTAFYCANARY";

fn payload_of(output: &Output) -> JsonValue {
    assert!(
        output.status.success(),
        "controller failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("controller JSON")
}

fn assert_no_canary(label: &str, text: &str) {
    assert!(
        !text.contains(CANARY_MARKER),
        "{label} carried the canary: {text}"
    );
}

impl EmbeddedControllerFixture {
    fn action_log(&self) -> String {
        std::fs::read_to_string(&self.actions_path).unwrap_or_default()
    }

    /// Grants routine browsing at the first site prompt and returns the
    /// snapshot taken under it. Later `command_for` runs keep the grant.
    fn routine_snapshot(&self, mode: &str) -> JsonValue {
        let (output, requests) = self.run_with_decisions(
            mode,
            "page-target",
            "GET",
            "/v1/snapshot",
            None,
            &[],
            &["allow_routine"],
        );
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["kind"], "origin");
        payload_of(&output)
    }
}

#[test]
fn the_sent_page_reader_carries_the_link_only_list_and_marks_links_with_it() {
    use std::process::Stdio;
    // What the origin evaluates for Send page to Octo, run against a results
    // page with a link to a link-only site, a script link and an ordinary one.
    let page = r#"
globalThis.location = { protocol: "https:", href: "https://search.example/?q=museum" };
const anchors = [
  ["City Museum", "https://museum.example/hours"],
  ["Hotels nearby", "https://www.booking.com/hotel/x.html"],
  ["Run", "javascript:alert(1)"],
].map(([innerText, href]) => ({ tagName: "A", innerText, href, getAttribute: (name) => name === "href" ? href : null }));
globalThis.document = { title: "museum", baseURI: "https://search.example/", body: { innerText: "Results" }, querySelectorAll: (s) => s === "*" ? anchors : [] };
"#;
    let script = format!(
        "{page}\n{}\nconst linkOnly = {{ api: globalThis.__instafyLinkOnly, sites: globalThis.__instafyLinkOnlySites }};\nprocess.stdout.write(JSON.stringify(globalThis.__instafyBrowserPageCapture.captureSentPage(globalThis.__instafyBrowserRedaction, {{ withhold: false, linkOnly }}).links));",
        sent_page_capture_script(),
    );
    let mut child = StdCommand::new("node")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node");
    child
        .stdin
        .take()
        .expect("node stdin")
        .write_all(script.as_bytes())
        .expect("write script");
    let output = child.wait_with_output().expect("node output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let links: serde_json::Value = serde_json::from_slice(&output.stdout).expect("links");
    assert_eq!(
        links,
        serde_json::json!([
            { "text": "City Museum", "href": "https://museum.example/hours" },
            { "text": "Hotels nearby", "href": "https://www.booking.com/hotel/x.html", "linkOnly": "Booking.com" }
        ])
    );
}

#[test]
fn embedded_policy_modules_publish_their_api_without_commonjs() {
    use std::process::Stdio;
    let script = format!(
        "{}\n{}\n{}\n{}\nprocess.stdout.write(JSON.stringify([typeof module, typeof globalThis.__instafyBrowserRedaction.redactPageObservation, typeof globalThis.__instafyBrowserActionPolicy.classifyStep, typeof globalThis.__instafyBrowserPageCapture.pageSecretSignalsInPage, typeof globalThis.__instafyBrowserFormSubmission.formSubmissionRulesInPage]));",
        embedded_plain_script(BROWSER_REDACTION_SCRIPT),
        embedded_plain_script(BROWSER_ACTION_POLICY_SCRIPT),
        embedded_plain_script(BROWSER_PAGE_CAPTURE_SCRIPT),
        embedded_plain_script(BROWSER_FORM_SUBMISSION_SCRIPT),
    );
    let mut child = StdCommand::new("node")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node");
    child
        .stdin
        .take()
        .expect("node stdin")
        .write_all(script.as_bytes())
        .expect("write script");
    let output = child.wait_with_output().expect("node output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // `node -` defines `module`; the wrapper is what keeps the package
    // scripts on their global path.
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        r#"["object","function","function","function","function"]"#
    );
    let embedded = embedded_shared_browser_script();
    assert!(
        embedded.find("__instafyBrowserRedaction") < embedded.find("__instafyBrowserActionPolicy")
    );
    // The controller reads the page's secret checks from the shared script,
    // so it must come before the controller itself.
    assert!(
        embedded.find("root.__instafyBrowserPageCapture")
            < embedded.find("globalThis.__instafyBrowserPageCapture;")
    );
    // So must the form submission rules the page describer joins in.
    assert!(
        embedded.find("root.__instafyBrowserFormSubmission")
            < embedded.find("globalThis.__instafyBrowserFormSubmission;")
    );
    // Larger than one Linux argv string may be, which is why it travels on stdin.
    assert!(embedded.len() > 64 * 1024);
}

#[test]
fn snapshots_mask_secrets_on_every_site_in_ask_and_routine() {
    // Ask mode: the site is approved, every action still asks.
    let fixture = EmbeddedControllerFixture::new();
    let output = fixture.run("canary-text", "GET", "/v1/snapshot", None);
    let payload = payload_of(&output);
    assert_no_canary(
        "ask-mode snapshot",
        &String::from_utf8_lossy(&output.stdout),
    );
    assert_eq!(payload["secretScreen"], false);
    assert!(
        payload["visibleText"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );

    // Routine browsing, on the first site and on a site opened by address.
    let fixture = EmbeddedControllerFixture::new();
    let payload = fixture.routine_snapshot("canary-text");
    assert_no_canary("routine snapshot", &payload.to_string());
    assert!(
        payload["visibleText"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );
    let navigate = json!({"url": "https://another-site.example/notes?session=INSTAFYCANARY9f8e7d6c5b4a3f2e1d"});
    let output = fixture
        .command_for(
            "canary-text",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(&navigate.to_string()),
        )
        .output()
        .expect("navigate under routine");
    let payload = payload_of(&output);
    assert!(!fixture.approval_dir.join("request.json").exists());
    assert_no_canary("navigation result", &payload.to_string());
    assert!(
        payload["url"]
            .as_str()
            .unwrap()
            .contains("session=REDACTED")
    );
    assert!(
        payload["visibleText"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );
    assert_no_canary("action log", &fixture.action_log());
    assert!(fixture.action_log().contains("session=REDACTED"));

    let status = fixture
        .command_for("canary-text", "page-target", "GET", "/v1/status", None)
        .output()
        .expect("status");
    assert_no_canary("status", &payload_of(&status).to_string());
}

#[test]
fn secret_screens_withhold_text_and_stay_withheld_until_a_new_page() {
    let fixture = EmbeddedControllerFixture::new();
    let output = fixture.run("secret-screen", "GET", "/v1/snapshot", None);
    let payload = payload_of(&output);
    assert_no_canary("secret screen", &String::from_utf8_lossy(&output.stdout));
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("tell the user in words which control")
    );
    // Control names stay so the agent can name the control.
    assert_eq!(payload["interactiveElements"][0]["label"], "Search");
    assert!(fixture.document_mark.exists());

    // The same document stays withheld even when nothing on it matches now.
    let payload = payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");

    // A new page lifts it. The site is approved, so the plain address opens
    // without a prompt.
    let (output, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/next"}"#),
        &["https://example.test"],
        &[],
    );
    assert!(requests.is_empty(), "{requests:?}");
    let payload = payload_of(&output);
    assert_eq!(payload["secretScreen"], false);
    assert_eq!(payload["visibleText"], "Fixture page");

    // Missing page answers withhold that observation, but do not mark the
    // document: a page caught mid-navigation is read normally next time.
    let fixture = EmbeddedControllerFixture::new();
    let payload = payload_of(&fixture.run("signals-fail", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(!fixture.document_mark.exists());
    let payload = payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], false);
    assert_eq!(payload["visibleText"], "Fixture page");
}

#[test]
fn a_snapshot_lists_only_what_a_person_can_see_and_actions_index_the_same_list() {
    let fixture = EmbeddedControllerFixture::new();
    let payload = payload_of(&fixture.run("hidden-controls", "GET", "/v1/snapshot", None));
    // The collapsed menu item is neither a control nor text in the
    // observation, and the shown control carries only its non-empty fields.
    assert_eq!(
        payload["interactiveElements"],
        json!([{
            "index": 0,
            "label": "Search",
            "tag": "input",
            "inputType": "text",
            "autocomplete": "off",
        }])
    );
    assert_eq!(payload["visibleText"], "Fixture page");
    assert_eq!(payload["secretScreen"], false);
    // The list says how many controls it leaves out, named or not, so a cut
    // list does not read as the whole page.
    assert_eq!(payload["omittedControls"], 2);

    // Index 0 of the snapshot is the same control for the action: the
    // second element on the page, not the hidden first one.
    let snapshot_id = payload["snapshotId"].as_str().expect("snapshot id");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "hidden-controls",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["allow_once"],
    );
    let clicked = payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["snapshotId"], snapshot_id);
    assert_eq!(clicked["snapshotId"], snapshot_id);
    assert_eq!(
        std::fs::read_to_string(&fixture.click_log).expect("click log"),
        "1\n"
    );

    // The hidden control has no index of its own.
    let body = json!({ "index": 1, "snapshotId": snapshot_id }).to_string();
    let output = fixture.run("hidden-controls", "POST", "/v1/click", Some(&body));
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("element index 1 is unavailable"),
        "unexpected hidden-index error: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(&fixture.click_log).expect("click log"),
        "1\n"
    );
}

/// A sign-in page names its fields and says to pause on them with
/// `request_human_input` (a task that went on past a sign-in ended the turn
/// with "sign in yourself, then tell me", twice). The pause on
/// those fields ends the turn for the person; Octo still never types into
/// them. A page without sign-in fields, and Octo's own tabs, which are for
/// reading, say nothing of it. The hint states the one rule the policies and
/// the browser skill state: a sign-in the person asked for, or one a step
/// they asked for needs, is paused on; any other ends that page, not the task.
#[test]
fn a_sign_in_page_names_its_fields_and_says_to_pause_on_them() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = payload_of(&fixture.run("sign-in-page", "GET", "/v1/snapshot", None));
    // The email and the password; never the checkbox or the button.
    assert_eq!(snapshot["signIn"]["fields"], json!([0, 1]));
    assert!(snapshot["signIn"].get("open").is_none(), "{snapshot}");
    let next = snapshot["signIn"]["next"]
        .as_str()
        .expect("what to do next");
    for words in [
        "Signing in is the person's step.",
        "If the person asked to sign in, or a step they asked for needs it, call request_human_input with this snapshotId and these fields' indices, then end the turn",
        "choose Let Octo continue",
        "Otherwise never sign in: use what the page shows without it and go on with the task.",
        "Never type into these fields.",
    ] {
        assert!(next.contains(words), "{words}: {next}");
    }
    assert!(!next.contains("goes on past"), "{next}");
    let snapshot_id = snapshot["snapshotId"].as_str().expect("snapshot id");

    // Typing there is still refused, before any prompt.
    let typed = fixture.run(
        "sign-in-page",
        "POST",
        "/v1/type",
        Some(
            &json!({ "index": 0, "snapshotId": snapshot_id, "text": "someone@example.test" })
                .to_string(),
        ),
    );
    assert!(!typed.status.success());
    assert!(
        String::from_utf8_lossy(&typed.stderr).contains("step_refused_sign_in"),
        "{}",
        String::from_utf8_lossy(&typed.stderr)
    );

    // The pause on the named fields ends the turn and asks the person.
    let paused = fixture.run(
        "sign-in-page",
        "POST",
        "/v1/request-human-input",
        Some(&json!({ "indices": [0, 1], "snapshotId": snapshot_id }).to_string()),
    );
    assert!(!paused.status.success());
    assert!(
        String::from_utf8_lossy(&paused.stderr).contains("[human_input_required_non_retryable]"),
        "{}",
        String::from_utf8_lossy(&paused.stderr)
    );
    let log = fixture.action_log();
    let request = log
        .lines()
        .filter_map(|line| serde_json::from_str::<JsonValue>(line).ok())
        .find(|action| action["type"] == "human_input")
        .expect("the pause asks the person");
    assert_eq!(
        request["humanInputRequest"]["fields"],
        json!([{ "label": "Highlighted field 1" }, { "label": "Highlighted field 2" }])
    );
    assert!(!log.contains("someone@example.test"));

    // A page with no sign-in fields and nothing that opens a sign-in page
    // says nothing of it.
    let plain = payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    assert!(plain.get("signIn").is_none(), "{plain}");

    // Nor does Octo's own tab, where the person is never asked to fill fields.
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    fixture.open_tab("https://example.test/login");
    let in_tab = payload_of(&fixture.call("sign-in-page", "GET", "/v1/snapshot", None));
    assert!(in_tab["tabId"].is_string(), "{in_tab}");
    assert!(in_tab.get("signIn").is_none(), "{in_tab}");
    let in_tab = payload_of(&fixture.call("sign-in-link", "GET", "/v1/snapshot", None));
    assert!(in_tab.get("signIn").is_none(), "{in_tab}");
}

/// The same task stopped on the site's home page, whose header has only a
/// "Sign in" link, with "use its Sign in control … tell me when you're ready":
/// a page without sign-in fields named nothing. Such a page names the control
/// that opens the sign-in page (never a federated sign-in, nor a form's submit
/// that would send it), so the turn reaches the fields and pauses there; the
/// real-Chromium sign-in fixture clicks it without a prompt.
#[test]
fn a_page_with_a_sign_in_link_names_it_so_a_needed_sign_in_reaches_its_fields() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = payload_of(&fixture.run("sign-in-link", "GET", "/v1/snapshot", None));
    assert_eq!(snapshot["interactiveElements"][2]["label"], "Log in");
    assert_eq!(snapshot["interactiveElements"][3]["label"], "Sign in");
    assert_eq!(snapshot["signIn"]["open"], json!(3), "{snapshot}");
    assert!(snapshot["signIn"].get("fields").is_none(), "{snapshot}");
    let next = snapshot["signIn"]["next"]
        .as_str()
        .expect("what to do next");
    for words in [
        "This opens the site's sign-in page.",
        "If the person asked to sign in, or a step they asked for needs it, click it, then pause on the sign-in page's fields with request_human_input.",
        "Otherwise leave it.",
    ] {
        assert!(next.contains(words), "{words}: {next}");
    }
    // A readable page with a sign-in link is still read: nothing says it ends.
    assert!(!next.contains("ends"), "{next}");
}

#[test]
fn a_page_is_withheld_when_its_unseen_text_or_controls_would_withhold_it() {
    // A credential page whose secret sits only in a control or text a person
    // cannot see is withheld exactly as when everything was read.
    for mode in ["hidden-secret-name", "hidden-secret-text"] {
        let fixture = EmbeddedControllerFixture::new();
        let output = fixture.run(mode, "GET", "/v1/snapshot", None);
        assert_no_canary(mode, &String::from_utf8_lossy(&output.stdout));
        let payload = payload_of(&output);
        assert_eq!(payload["secretScreen"], true, "{mode}");
        assert_eq!(payload["visibleText"], "", "{mode}");
        assert_eq!(
            payload["interactiveElements"]
                .as_array()
                .expect("elements")
                .len(),
            1,
            "{mode}"
        );
        assert_eq!(payload["interactiveElements"][0]["label"], "Search");
        assert!(fixture.document_mark.exists(), "{mode}");
    }
}

#[test]
fn snapshot_controls_leave_out_empty_fields_and_name_same_site_links_by_path() {
    let fixture = EmbeddedControllerFixture::new();
    let payload = payload_of(&fixture.run("page-links", "GET", "/v1/snapshot", None));
    assert_eq!(
        payload["interactiveElements"],
        json!([
            { "index": 0, "label": "Quarterly report", "tag": "a", "href": "/reports/q3?view=full" },
            { "index": 1, "label": "Pricing", "tag": "a", "href": "https://other.example/pricing" },
            {
                "index": 2,
                "label": "Look-alike",
                "tag": "a",
                "href": "https://example.test.other.example/reports",
            },
            {
                "index": 3,
                "label": "Main menu",
                "tag": "button",
                "inputType": "button",
                "area": "header",
                "expanded": false,
            },
            // A page-supplied state or area outside the fixed values is dropped.
            { "index": 4, "label": "Account", "tag": "button", "inputType": "button" },
        ])
    );
    // Nothing is left out, so there is no count.
    assert!(payload.get("omittedControls").is_none(), "{payload}");

    // The approval still binds the link's full address.
    let snapshot_id = payload["snapshotId"].as_str().expect("snapshot id");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "page-links",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["destinationOrigin"], "https://example.test");
    let full_address = {
        use sha2::{Digest, Sha256};
        Sha256::digest(b"https://example.test/reports/q3?view=full")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    assert_eq!(requests[0]["destinationFingerprint"], full_address);
}

#[test]
fn mcp_results_carry_compact_json_text_beside_the_structured_payload() {
    let payload = json!({
        "ok": true,
        "visibleText": "Fixture page",
        "interactiveElements": [{ "index": 0, "label": "Search", "tag": "input" }],
    });
    let result = successful_tool_result(payload.clone());
    assert_eq!(result.is_error, Some(false));
    assert_eq!(result.content.len(), 1);
    let text = &result.content[0].raw.as_text().expect("text content").text;
    assert_eq!(
        text,
        &serde_json::to_string(&payload).expect("compact JSON")
    );
    assert!(!text.contains('\n'));
    assert_eq!(result.structured_content, Some(payload));
}

#[test]
fn navigate_takes_a_snapshot_link_path_on_the_page_site_only() {
    // A path from a snapshot's href passes the runtime's check; a path that
    // names another host does not, however it is spelled.
    let navigate = |url: &str| {
        mcp_tool_request(
            "navigate",
            Some(JsonMap::from_iter([("url".to_string(), json!(url))])),
        )
    };
    assert!(navigate("/app/belege/BEL-2026-1200?view=full").is_ok());
    assert!(navigate("https://example.test/app").is_ok());
    for escaping in [
        "//other.example/app",
        "/\\other.example/app",
        "/\t/other.example/app",
        "/\\user:secret@other.example/",
    ] {
        assert!(navigate(escaping).is_err(), "{escaping:?} passed");
    }
    assert!(navigate("app/belege").is_err());

    // The controller resolves the path against the page's own site, and the
    // approval binds the full address.
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"/reports/q3?view=full"}"#),
        &[],
        &["allow_origin"],
    );
    let payload = payload_of(&output);
    assert_eq!(payload["url"], "https://example.test/reports/q3?view=full");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["operation"], "approve-origin");
    assert_eq!(requests[0]["destinationOrigin"], "https://example.test");
    assert_eq!(
        requests[0]["display"]["label"],
        "Open https://example.test/reports/q3?view=full"
    );
    let full_address = {
        use sha2::{Digest, Sha256};
        Sha256::digest(b"https://example.test/reports/q3?view=full")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    assert_eq!(requests[0]["destinationFingerprint"], full_address);

    // The controller holds the same line when called directly.
    for (mode, url, refusal) in [
        (
            "safe",
            "//other.example/app",
            "must stay on the page's site",
        ),
        (
            "safe",
            "/\\other.example/app",
            "must stay on the page's site",
        ),
        ("blank-page", "/reports/q3", "needs a full address"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let body = json!({ "url": url }).to_string();
        let output = fixture.run(mode, "POST", "/v1/navigate", Some(&body));
        assert!(!output.status.success(), "{mode} {url:?} navigated");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(refusal), "{mode} {url:?}: {stderr}");
    }
}

#[test]
fn routine_asks_for_named_categories_with_the_category_in_the_label() {
    for (mode, label) in [
        ("invite-button", "Sharing or access change: Invite member"),
        ("export-link", "Download or export: Export CSV"),
        ("generate-key", "Key or password change: Generate API key"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id});
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
            &[],
            &["allow_routine", "deny"],
        );
        assert!(!output.status.success(), "{mode} ran without asking");
        assert_eq!(requests.len(), 2, "{mode}");
        assert_eq!(requests[1]["kind"], "action");
        assert_eq!(requests[1]["display"]["label"], label);
        assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
        assert!(!fixture.action_log().contains("\"type\":\"click\""));
    }

    // An ordinary control stays free under routine, and so does typing an
    // address for a site the run has not used yet.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = fixture.routine_snapshot("plain-button");
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
    let output = fixture
        .command_for(
            "plain-button",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
        )
        .output()
        .expect("routine click");
    payload_of(&output);
    let output = fixture
        .command_for(
            "plain-button",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://never-used.example/start"}"#),
        )
        .output()
        .expect("routine navigation to a new site");
    payload_of(&output);
    assert!(!fixture.approval_dir.join("request.json").exists());

    // A risky address asks under routine, by its address alone.
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/reports/export.csv"}"#),
        &[],
        &["allow_routine", "deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]["display"]["label"],
        "Open https://example.test/reports/export.csv"
    );
    assert_eq!(
        requests[1]["display"]["label"],
        "Download or export: Go to https://example.test/reports/export.csv"
    );

    // Without the page's structural facts nothing is assumed safe.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("no-policy");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, requests) = fixture.run_with_decisions(
        "no-policy",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &[],
        &["allow_routine", "deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 2);
}

#[test]
fn reveal_sign_in_and_upload_steps_are_refused_without_a_prompt_in_every_mode() {
    for (mode, path, extra, code) in [
        ("reveal-key", "/v1/click", json!({}), "step_refused_secret"),
        (
            "sign-in-email",
            "/v1/type",
            json!({"text": "person@example.test"}),
            "step_refused_sign_in",
        ),
        ("file-input", "/v1/click", json!({}), "step_refused_upload"),
    ] {
        // Ask mode.
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(!output.status.success(), "{mode} ask mode");
        assert!(requests.is_empty(), "{mode} prompted in ask mode");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(code),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // Routine browsing.
        let fixture = EmbeddedControllerFixture::new();
        let snapshot = fixture.routine_snapshot(mode);
        let mut body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let output = fixture
            .command_for(mode, "page-target", "POST", path, Some(&body.to_string()))
            .output()
            .expect("refused routine step");
        assert!(!output.status.success(), "{mode} routine");
        assert!(String::from_utf8_lossy(&output.stderr).contains(code));
        assert!(!fixture.approval_dir.join("request.json").exists());
        let log = fixture.action_log();
        assert!(!log.contains("\"type\":\"click\"") && !log.contains("\"type\":\"type\""));
    }
}

#[test]
fn credential_steps_withhold_the_page_before_they_run() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("credential-row");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, requests) = fixture.run_with_decisions(
        "credential-row",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &[],
        &["allow_routine", "allow_once"],
    );
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]["display"]["label"],
        "May show a secret: Production key ••••••••"
    );
    let payload = payload_of(&output);
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(fixture.document_mark.exists());
    let payload = payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], true);
}

#[test]
fn credential_steps_withhold_the_page_they_open_even_when_it_loads_late() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = fixture.routine_snapshot("credential-row");
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
    let (output, requests) = fixture.run_with_decisions(
        "credential-row",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &[],
        &["allow_routine", "allow_once"],
    );
    assert_eq!(requests.len(), 2);
    assert_eq!(payload_of(&output)["secretScreen"], true);
    let record_path = fixture.approval_dir.join("withhold-next.json");
    let record: JsonValue =
        serde_json::from_slice(&std::fs::read(&record_path).expect("withheld-document record"))
            .expect("record JSON");
    assert_eq!(record["afterDocument"], "DOCUMENT1");
    assert_eq!(record["runId"], fixture.run_id.to_string());

    // The step's page navigates after the click returned: a new document
    // without the in-page mark, on the same address, showing nothing the
    // page checks recognize.
    std::fs::remove_file(&fixture.document_mark).expect("new document drops the mark");
    std::fs::write(&fixture.document_id, "DOCUMENT2").expect("late navigation");
    let snapshot_now = || {
        payload_of(
            &fixture
                .command_for("safe", "page-target", "GET", "/v1/snapshot", None)
                .output()
                .expect("snapshot after a late navigation"),
        )
    };
    let payload = snapshot_now();
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(fixture.document_mark.exists());
    assert!(!record_path.exists());
    // It stays withheld as long as that document does.
    assert_eq!(snapshot_now()["secretScreen"], true);

    // An address the agent opens itself is read normally, and clears a record
    // that no document consumed yet.
    std::fs::write(
        &record_path,
        serde_json::to_vec(&record).expect("record bytes"),
    )
    .expect("restore record");
    #[cfg(unix)]
    std::fs::set_permissions(&record_path, std::fs::Permissions::from_mode(0o600))
        .expect("protect record");
    let output = fixture
        .command_for(
            "safe",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://example.test/next"}"#),
        )
        .output()
        .expect("routine navigation");
    let payload = payload_of(&output);
    assert_eq!(payload["secretScreen"], false);
    assert_eq!(payload["visibleText"], "Fixture page");
    assert!(!record_path.exists());
}

#[test]
fn long_approval_labels_stay_valid_for_the_origin() {
    for shift in 0..=10 {
        let mode = format!("long-label-{shift}");
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(&mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id});
        let (output, requests) = fixture.run_with_decisions(
            &mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
            &["https://example.test"],
            &["allow_once"],
        );
        payload_of(&output);
        assert_eq!(requests.len(), 1, "{mode}");
        let label = requests[0]["display"]["label"].as_str().expect("label");
        // The origin's own check: non-empty, bounded, and equal to its
        // whitespace-joined form.
        assert!(!label.is_empty() && label.len() <= 240, "{mode}: {label}");
        assert_eq!(
            label.split_whitespace().collect::<Vec<_>>().join(" "),
            label,
            "{mode}"
        );
        // The text the control shows leads, cut on its own, and its other
        // name follows whole.
        assert!(label.contains("Quarterly team"), "{mode}: {label}");
        assert!(
            label.ends_with("\u{2026} (also called \"Open report\")"),
            "{mode}: {label}"
        );
        assert!(!label.contains('\u{FFFD}'), "{mode}: {label}");
    }
}

#[test]
fn masked_display_text_keeps_ordinary_addresses() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("url-label");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, requests) = fixture.run_with_decisions(
        "url-label",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    let label = requests[0]["display"]["label"].as_str().expect("label");
    assert!(
        label.contains("https://github.com/instafy-dev/instafy/pull/615/files?token=REDACTED"),
        "{label}"
    );
    assert_no_canary("approval label", label);
    let log = fixture.action_log();
    assert!(
        log.contains("https://github.com/instafy-dev/instafy/pull/615/files?token=REDACTED"),
        "{log}"
    );
    assert_no_canary("action log", &log);
}

#[test]
fn stderr_approval_labels_and_action_log_never_carry_page_secrets() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("click-error-canary");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, _) = fixture.run_with_decisions(
        "click-error-canary",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_no_canary("stderr", &stderr);
    assert!(stderr.contains("[redacted secret]"), "{stderr}");

    let fixture = EmbeddedControllerFixture::new();
    let snapshot = payload_of(&fixture.run("canary-label", "GET", "/v1/snapshot", None));
    assert_no_canary("snapshot names", &snapshot.to_string());
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
    let (output, requests) = fixture.run_with_decisions(
        "canary-label",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert_no_canary("approval request", &requests[0].to_string());
    assert!(
        requests[0]["display"]["label"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );
    let log = fixture.action_log();
    assert!(log.contains("\"type\":\"click\""));
    assert_no_canary("action log", &log);
}

#[test]
fn every_controller_connection_denies_downloads() {
    let fixture = EmbeddedControllerFixture::new();
    payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    payload_of(&fixture.run("safe", "GET", "/v1/status", None));
    let calls: Vec<JsonValue> = std::fs::read_to_string(&fixture.cdp_log)
        .expect("browser CDP log")
        .lines()
        .map(|line| serde_json::from_str(line).expect("CDP log line"))
        .collect();
    // Each connection denies downloads first and closes at the end, which
    // removes Playwright's temporary download folder.
    assert_eq!(calls.len(), 4);
    for pair in calls.chunks(2) {
        assert_eq!(pair[0]["method"], "Browser.setDownloadBehavior");
        assert_eq!(pair[0]["params"], json!({"behavior": "deny"}));
        assert_eq!(pair[1]["method"], "close");
    }
}

#[test]
fn only_an_attested_browser_host_starts_runs_in_routine_browsing() {
    use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};

    {
        let _boot_time_or_no_browser = force_lazy_mode_for_tests(None);
        assert_eq!(run_approval_start(), ApprovalStart::Ask);
    }
    for persist in [false, true] {
        let _host = force_lazy_mode_for_tests(Some(LazyMode { persist }));
        assert_eq!(run_approval_start(), ApprovalStart::Routine);
    }
}

/// The guard a job acquires starts its run as this process decides: routine
/// browsing on an attested browser host, Ask everywhere else. Nothing the job
/// passes can choose it.
#[tokio::test]
async fn a_jobs_guard_starts_its_run_as_the_runtime_decides() {
    use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};

    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    let state_path = approval_dir.join("state.json");
    let acquire = || {
        let cancel_signal = JobCancelSignal::new();
        let guard = SharedBrowserAgentControlGuard::acquire_at(
            path.clone(),
            approval_dir.clone(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "page-target",
            "Octo",
            None,
            &[],
            cancel_signal.clone(),
        )
        .expect("acquire a job's guard");
        (guard, cancel_signal)
    };

    {
        let _boot_time_or_no_browser = force_lazy_mode_for_tests(None);
        let (guard, cancel_signal) = acquire();
        assert!(path.exists());
        assert!(!state_path.exists(), "an Ask start writes no state");
        cancel_signal.confirm_shared_browser_shutdown();
        drop(guard);
    }
    for persist in [false, true] {
        let _host = force_lazy_mode_for_tests(Some(LazyMode { persist }));
        let (guard, cancel_signal) = acquire();
        let marker: JsonValue =
            serde_json::from_slice(&std::fs::read(&path).expect("marker")).expect("marker JSON");
        let state: JsonValue =
            serde_json::from_slice(&std::fs::read(&state_path).expect("routine state"))
                .expect("state JSON");
        assert_eq!(state["routineBrowsingAllowed"], true);
        for key in ["ownerId", "runId", "initiatorUserId", "browserPageId"] {
            assert_eq!(state[key], marker[key], "{key}");
        }
        cancel_signal.confirm_shared_browser_shutdown();
        drop(guard);
        assert!(!state_path.exists(), "the run's grant ends with the run");
    }
}

#[tokio::test]
async fn a_routine_start_writes_bound_private_state_that_the_run_end_revokes() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    let run_id = Uuid::new_v4();
    let initiator_user_id = Uuid::new_v4();
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        approval_dir.clone(),
        ApprovalStart::Routine,
        run_id,
        initiator_user_id,
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire routine run");

    let marker: JsonValue =
        serde_json::from_slice(&std::fs::read(&path).expect("marker")).expect("marker JSON");
    let state_path = approval_dir.join("state.json");
    let state: JsonValue =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state JSON");
    assert_eq!(
        state,
        json!({
            "version": 1,
            "ownerId": marker["ownerId"],
            "runId": run_id.to_string(),
            "initiatorUserId": initiator_user_id.to_string(),
            "browserPageId": "page-target",
            "approvedOrigins": [],
            "consumedApprovalIds": [],
            "routineBrowsingAllowed": true,
        })
    );
    for key in ["ownerId", "runId", "initiatorUserId", "browserPageId"] {
        assert_eq!(state[key], marker[key], "{key}");
    }
    assert_eq!(state["ownerId"], guard.owner_id.to_lowercase());
    #[cfg(unix)]
    assert_eq!(
        std::fs::metadata(&state_path)
            .expect("state metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let entries = std::fs::read_dir(&approval_dir)
        .expect("approval directory")
        .map(|entry| entry.expect("entry").file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec![std::ffi::OsString::from("state.json")]);

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert!(!state_path.exists(), "the run's grant ends with the run");
    assert!(!path.exists());

    // Ask writes no state: the scripts start from their empty Ask state.
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        approval_dir.clone(),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire ask run");
    assert_eq!(
        std::fs::read_dir(&approval_dir)
            .expect("approval directory")
            .count(),
        0
    );
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
}

#[test]
fn a_routine_start_that_cannot_be_written_publishes_no_state() {
    let directory = tempfile::tempdir().expect("approval tempdir");
    let owner_id = Uuid::new_v4().to_string();
    // The temporary file's place is taken, so the write fails.
    std::fs::create_dir(
        directory
            .path()
            .join(format!(".instafy-approval-{owner_id}")),
    )
    .expect("block the temporary file");
    let error = write_routine_approval_state(
        directory.path(),
        &owner_id,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
    )
    .expect_err("a blocked write fails");
    assert!(format!("{error:#}").contains("Shared Browser approval state"));
    assert!(!directory.path().join("state.json").exists());
}

#[test]
fn a_routine_start_reads_navigates_and_follows_links_to_new_sites_without_a_prompt() {
    let fixture = EmbeddedControllerFixture::new();
    // "100" fails any prompt this run would publish as unanswered.
    let run = |mode: &str, method: &str, path: &str, body: Option<&str>| {
        fixture.prepare_routine_start("page-target");
        let output = fixture
            .command_for_with_timeout(mode, "page-target", method, path, body, "100")
            .output()
            .expect("run routine step");
        assert!(
            !fixture.approval_dir.join("request.json").exists(),
            "{method} {path} asked"
        );
        payload_of(&output)
    };

    // From the blank page to a site the run has not used, then reading there.
    let navigated = run(
        "blank-page",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://new.example/x"}"#),
    );
    assert_eq!(navigated["url"], "https://new.example/x");
    assert_ne!(navigated["redacted"], true);
    let snapshot = run("safe", "GET", "/v1/snapshot", None);
    assert_eq!(snapshot["url"], "https://example.test/");
    assert_ne!(snapshot["redacted"], true);

    // A second site, by address and by a plain cross-site link.
    let navigated = run(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://another.example/docs"}"#),
    );
    assert_eq!(navigated["url"], "https://another.example/docs");
    let snapshot = run("cross-site-link", "GET", "/v1/snapshot", None);
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]}).to_string();
    run("cross-site-link", "POST", "/v1/click", Some(&body));
    assert!(fixture.action_log().contains("\"type\":\"click\""));

    // Ordinary clicks, typing that does not submit and non-activation keys.
    for (mode, path, extra) in [
        ("plain-button", "/v1/click", json!({})),
        ("safe", "/v1/type", json!({"text": "ordinary search"})),
        ("safe", "/v1/press", json!({"key": "Tab"})),
    ] {
        let snapshot = run(mode, "GET", "/v1/snapshot", None);
        let mut body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        run(mode, "POST", path, Some(&body.to_string()));
    }
}

#[test]
fn a_routine_start_still_asks_for_every_risky_step() {
    let clicks = [
        ("invite-button", "Sharing or access change: Invite member"),
        ("export-link", "Download or export: Export CSV"),
        ("generate-key", "Key or password change: Generate API key"),
        ("aria-delete", ""),
        ("form-submit-button", ""),
        // Script-driven save buttons have no form to check.
        ("save-button", "Change something: Speichern"),
        ("save-button-en", "Change something: Save changes"),
    ];
    for (mode, label) in clicks {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for(mode, "page-target", "POST", "/v1/click", Some(&body)),
            &["deny"],
        );
        assert!(!output.status.success(), "{mode} ran without asking");
        assert_eq!(requests.len(), 1, "{mode}");
        assert_eq!(requests[0]["kind"], "action", "{mode}");
        if !label.is_empty() {
            assert_eq!(requests[0]["display"]["label"], label, "{mode}");
        }
        assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
        assert!(
            !fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }

    for (path, extra) in [
        ("/v1/type", json!({"text": "ordinary text", "submit": true})),
        ("/v1/press", json!({"key": "Enter"})),
        ("/v1/press", json!({"key": "Space"})),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id("safe");
        fixture.prepare_routine_start("page-target");
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for("safe", "page-target", "POST", path, Some(&body.to_string())),
            &["deny"],
        );
        assert!(
            !output.status.success(),
            "{path} {extra} ran without asking"
        );
        assert_eq!(requests.len(), 1, "{path} {extra}");
        assert_eq!(requests[0]["kind"], "action");
    }

    for url in [
        "https://example.test/logout",
        "https://example.test/reports/export?format=csv",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        fixture.prepare_routine_start("page-target");
        let body = json!({ "url": url }).to_string();
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for("safe", "page-target", "POST", "/v1/navigate", Some(&body)),
            &["deny"],
        );
        assert!(!output.status.success(), "{url} opened without asking");
        assert_eq!(requests.len(), 1, "{url}");
        assert_eq!(requests[0]["operation"], "navigate");
        assert!(!fixture.action_log().contains("\"type\":\"navigate\""));
    }

    // Unanswered, a risky step fails as unanswered and does nothing.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("save-button");
    fixture.prepare_routine_start("page-target");
    let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
    let output = fixture
        .command_for_with_timeout(
            "save-button",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            "100",
        )
        .output()
        .expect("unanswered routine step");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("approval_timeout_non_retryable"));
    assert!(!fixture.action_log().contains("\"type\":\"click\""));

    // An allowed risky step runs once, and the run stays in routine browsing.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("save-button");
    fixture.prepare_routine_start("page-target");
    let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
    let (output, requests) = fixture.decide_prepared(
        fixture.command_for(
            "save-button",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
        ),
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert!(fixture.action_log().contains("\"type\":\"click\""));
    let output = fixture
        .command_for_with_timeout(
            "save-button",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://later.example/next"}"#),
            "100",
        )
        .output()
        .expect("routine navigation after an answered prompt");
    payload_of(&output);
}

/// A commit word only marks a button. Menu items, tabs, tree items,
/// disclosure and menu openers and navigation items whose label holds one
/// ("Neue Rechnung", "Start", "Neu") are navigation, so routine browsing runs
/// them without a prompt, while the formless save buttons above still ask.
#[test]
fn a_routine_start_runs_menus_tabs_and_openers_with_commit_words_without_a_prompt() {
    for mode in [
        "menu-item-new",
        "tab-start",
        "tree-item-new",
        "summary-edit",
        "opener-new",
        "nav-start",
        "menu-item-bookings",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        // "100" fails any prompt this click would publish as unanswered.
        let output = fixture
            .command_for_with_timeout(mode, "page-target", "POST", "/v1/click", Some(&body), "100")
            .output()
            .expect("routine click");
        assert!(
            output.status.success(),
            "{mode} asked: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !fixture.approval_dir.join("request.json").exists(),
            "{mode} asked"
        );
        assert!(
            fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }
}

/// The lines the fake page wrote for each step that chose an option: `choose <index> <value>`.
fn chosen_options(fixture: &EmbeddedControllerFixture) -> Vec<String> {
    std::fs::read_to_string(&fixture.click_log)
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with("choose "))
        .map(str::to_string)
        .collect()
}

/// A journey planner's station list labelled "Start" asked as a commit, named by all of its
/// stations run together, and no step could pick one. Under routine browsing Octo chooses an
/// option by its label with no prompt, case and accents aside; the list is named by its own
/// label and says which option it holds; and a click on it is no commit button.
#[test]
fn a_routine_start_chooses_a_station_by_its_label_without_a_prompt() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = fixture.routine_snapshot("station-list");
    let station = &snapshot["interactiveElements"][0];
    assert_eq!(station["label"], "Start");
    assert_eq!(station["tag"], "select");
    assert_eq!(station["chosen"], "Trindade");
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"], "option": "sao bento"})
        .to_string();
    // "100" fails any prompt this step would publish as unanswered.
    let output = fixture
        .command_for_with_timeout(
            "station-list",
            "page-target",
            "POST",
            "/v1/choose",
            Some(&body),
            "100",
        )
        .output()
        .expect("routine choose");
    let chosen = payload_of(&output);
    assert!(
        !fixture.approval_dir.join("request.json").exists(),
        "choosing asked"
    );
    assert_eq!(
        chosen["activity"],
        json!({"step": "choose", "url": "https://example.test/", "approval": "routine"})
    );
    assert_eq!(chosen_options(&fixture), ["choose 0 {\"index\":4}"]);
    assert!(
        fixture
            .action_log()
            .contains(r#""type":"click","label":"Choose \"São Bento\" in \"Start\"""#),
        "{}",
        fixture.action_log()
    );

    // A click on the list opens it; "Start" names a value, not a step.
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]}).to_string();
    let output = fixture
        .command_for_with_timeout(
            "station-list",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            "100",
        )
        .output()
        .expect("routine click on a list");
    payload_of(&output);
    assert!(
        !fixture.approval_dir.join("request.json").exists(),
        "a click on a list asked"
    );
}

/// A choice whose list or option says it is risky asks, in every mode, naming the option and
/// the list by its own label ("Delete selected" in "Bulk actions"). It is bound to the page's own
/// site and sends nothing; nothing is chosen until the person allows it.
#[test]
fn a_risky_choice_asks_naming_the_option_and_the_list() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = fixture.routine_snapshot("bulk-actions");
    let body =
        json!({"index": 0, "snapshotId": snapshot["snapshotId"], "option": "Delete selected"})
            .to_string();
    let (output, requests) = fixture.decide_prepared(
        fixture.command_for(
            "bulk-actions",
            "page-target",
            "POST",
            "/v1/choose",
            Some(&body),
        ),
        &["deny"],
    );
    assert!(
        !output.status.success(),
        "a risky choice ran without asking"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["kind"], "action");
    assert_eq!(requests[0]["operation"], "choose");
    assert_eq!(
        requests[0]["display"]["label"],
        "Delete, cancel or sign out: Delete selected \u{b7} In: Bulk actions"
    );
    assert_eq!(requests[0]["destinationOrigin"], JsonValue::Null);
    assert_eq!(requests[0]["sourceOrigin"], "https://example.test");
    assert!(
        chosen_options(&fixture).is_empty(),
        "chosen before the person allowed it"
    );

    let snapshot = fixture.routine_snapshot("bulk-actions");
    let body =
        json!({"index": 0, "snapshotId": snapshot["snapshotId"], "option": "Delete selected"})
            .to_string();
    let (output, requests) = fixture.decide_prepared(
        fixture.command_for(
            "bulk-actions",
            "page-target",
            "POST",
            "/v1/choose",
            Some(&body),
        ),
        &["allow_once"],
    );
    let chosen = payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert_eq!(chosen["activity"]["approval"], "once");
    assert_eq!(chosen_options(&fixture), ["choose 0 {\"index\":1}"]);

    // Selecting every row is an ordinary choice.
    let snapshot = fixture.routine_snapshot("bulk-actions");
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"], "option": "Select all"})
        .to_string();
    let output = fixture
        .command_for_with_timeout(
            "bulk-actions",
            "page-target",
            "POST",
            "/v1/choose",
            Some(&body),
            "100",
        )
        .output()
        .expect("routine choice");
    payload_of(&output);
}

/// In Ask mode every choice asks, as every typed text does, and a click on a list asks under
/// the list's own label, never its options run together as an older describer reported them.
#[test]
fn ask_mode_asks_for_each_choice_and_names_a_clicked_list_by_its_label() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("station-list-run-together");
    let body = json!({"index": 0, "snapshotId": snapshot_id, "option": "Aliados"}).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "station-list-run-together",
        "page-target",
        "POST",
        "/v1/choose",
        Some(&body),
        &["https://example.test"],
        &["deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["operation"], "choose");
    assert_eq!(
        requests[0]["display"]["label"],
        "Change something: Aliados \u{b7} In: Start"
    );
    assert!(chosen_options(&fixture).is_empty());

    let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "station-list-run-together",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["operation"], "click");
    assert_eq!(requests[0]["display"]["label"], "Change something: Start");
}

/// `choose` sets a select and nothing else; an option the list does not have, or one the page
/// turned off, chooses nothing, and the answer lists the options so the next try names one
/// exactly. A secret screen says which option no list holds.
#[test]
fn choose_refuses_what_is_no_list_and_options_a_list_does_not_offer() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = fixture.routine_snapshot("safe");
    let body =
        json!({"index": 0, "snapshotId": snapshot["snapshotId"], "option": "Belém"}).to_string();
    let output = fixture
        .command_for_with_timeout(
            "safe",
            "page-target",
            "POST",
            "/v1/choose",
            Some(&body),
            "100",
        )
        .output()
        .expect("choose on a field");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("choose sets a list the page draws as a select, and this control is not one"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    for (mode, option, reason) in [
        (
            "station-list",
            "Sao Bentoo",
            "No option in \"Start\" is called \"Sao Bentoo\", so nothing was chosen. Its options: 24 Agosto, Aeroporto, Aliados, Campanhã, São Bento, Trindade. Choose one of them by its label.",
        ),
        (
            "station-list-turned-off",
            "Campanhã",
            "The page has turned off \"Campanhã\" in \"Start\", so nothing was chosen. Its options: 24 Agosto, Aeroporto, Aliados, São Bento, Trindade.",
        ),
    ] {
        let snapshot = fixture.routine_snapshot(mode);
        let body =
            json!({"index": 0, "snapshotId": snapshot["snapshotId"], "option": option}).to_string();
        let output = fixture
            .command_for_with_timeout(
                mode,
                "page-target",
                "POST",
                "/v1/choose",
                Some(&body),
                "100",
            )
            .output()
            .expect("choose an option the list does not offer");
        assert!(!output.status.success(), "{mode}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(reason), "{mode}: {stderr}");
        assert!(!stderr.contains("_non_retryable"), "{mode}: {stderr}");
    }
    assert!(chosen_options(&fixture).is_empty());
    assert!(!fixture.approval_dir.join("request.json").exists());

    let snapshot = fixture.routine_snapshot("station-list-secret-screen");
    assert_eq!(snapshot["secretScreen"], true);
    assert_eq!(snapshot["interactiveElements"][0]["tag"], "select");
    assert_eq!(snapshot["interactiveElements"][0].get("chosen"), None);
}

/// In a dogfood run a bookkeeping app's hamburger ("Menü ein-/ausklappen")
/// and its unnamed avatar button asked under routine browsing. Both are <button>s without a
/// type attribute, which the browser reports as type "submit" even outside a
/// form, and the consequential-word check read the type. A typeless button
/// outside a form, a disclosure toggle and an ordinary control in a POST form
/// whose text holds commit words are routine browsing.
#[test]
fn a_routine_start_runs_typeless_buttons_toggles_and_post_form_controls_without_a_prompt() {
    for mode in [
        "ff-menu-toggle",
        "ff-avatar",
        "post-form-toggle",
        "post-form-field",
        "plain-button-typeless",
        "opener-new-typeless",
        "nav-start-typeless",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        // "100" fails any prompt this click would publish as unanswered.
        let output = fixture
            .command_for_with_timeout(mode, "page-target", "POST", "/v1/click", Some(&body), "100")
            .output()
            .expect("routine click");
        assert!(
            output.status.success(),
            "{mode} asked: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !fixture.approval_dir.join("request.json").exists(),
            "{mode} asked"
        );
        assert!(
            fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }
}

/// Reading only the control's own names keeps every risky step asking: a
/// typeless save or invite button, a POST form's own submit button, and an
/// icon-only trash button, whose prompt names it instead of an index.
#[test]
fn a_routine_start_still_asks_for_typeless_commit_buttons_submits_and_risky_icons() {
    for (mode, label) in [
        ("save-button-typeless", "Change something: Speichern"),
        ("save-button-en-typeless", "Change something: Save changes"),
        (
            "invite-button-typeless",
            "Sharing or access change: Invite member",
        ),
        (
            "generate-key-typeless",
            "Key or password change: Generate API key",
        ),
        ("post-form-submit", "Change something: Festschreiben"),
        (
            "icon-trash",
            "Delete, cancel or sign out: delete button in the top right",
        ),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for(mode, "page-target", "POST", "/v1/click", Some(&body)),
            &["deny"],
        );
        assert!(!output.status.success(), "{mode} ran without asking");
        assert_eq!(requests.len(), 1, "{mode}");
        assert_eq!(requests[0]["kind"], "action", "{mode}");
        assert_eq!(requests[0]["display"]["label"], label, "{mode}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
        assert!(
            !fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }
}

/// Bookkeeping steps that rebook, reverse, file, issue, record, reconcile or
/// close a record ask under routine browsing. A dogfood harness found them
/// running without a prompt on a <button> with no type attribute outside any
/// form and on a type="button" control inside a POST form, where no form
/// submission check sees them; only their own names tell them apart.
#[test]
fn a_routine_start_still_asks_for_bookkeeping_write_steps() {
    for label in [
        "Umbuchen",
        "Ausbuchen",
        "Abbuchen",
        "Rückbuchen",
        "Gegenbuchen",
        "Stornobuchung",
        "An FinanzOnline übermitteln",
        "Einreichen",
        "UVA abgeben",
        "Rechnung ausstellen",
        "Beleg erfassen",
        "Abgleichen",
        "Erledigt",
        "Fakturieren",
        "Verrechnen",
        "Reconcile",
        "Void invoice",
        "Write off",
        "Issue refund",
        "File tax return",
    ] {
        for mode in [
            format!("button:{label}-typeless"),
            format!("post-form-button:{label}"),
        ] {
            let fixture = EmbeddedControllerFixture::new();
            let snapshot_id = fixture.snapshot_id(&mode);
            fixture.prepare_routine_start("page-target");
            let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
            let (output, requests) = fixture.decide_prepared(
                fixture.command_for(&mode, "page-target", "POST", "/v1/click", Some(&body)),
                &["deny"],
            );
            assert!(!output.status.success(), "{mode} ran without asking");
            assert_eq!(requests.len(), 1, "{mode}");
            assert_eq!(requests[0]["kind"], "action", "{mode}");
            assert_eq!(
                requests[0]["display"]["label"],
                format!("Change something: {label}"),
                "{mode}"
            );
            assert!(
                !fixture.action_log().contains("\"type\":\"click\""),
                "{mode} clicked"
            );
        }
    }
}

/// On a menu item the verbs that write a record still ask, while names of
/// lists ("Buchungen", "Stornobuchung") and the steps that only fill in a
/// record ("Erfassen", "Abgleichen") stay navigation: the classifier's commit
/// words never apply to menu items, tabs or navigation entries, and a "File"
/// menu is not a filing step.
#[test]
fn a_routine_start_asks_for_menu_items_that_write_and_frees_menu_items_that_name_lists() {
    for label in [
        "Umbuchen",
        "Stornobuchen",
        "An FinanzOnline übermitteln",
        "Einreichen",
        "Rechnung ausstellen",
    ] {
        let mode = format!("menu-item:{label}");
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(&mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        // "100" fails the prompt this click must publish as unanswered.
        let output = fixture
            .command_for_with_timeout(
                &mode,
                "page-target",
                "POST",
                "/v1/click",
                Some(&body),
                "100",
            )
            .output()
            .expect("routine click");
        assert!(!output.status.success(), "{mode} ran without asking");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("approval_timeout_non_retryable"),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for mode in [
        "menu-item:Buchungen",
        "menu-item:Stornobuchung",
        "menu-item:Belege erfassen",
        "menu-item:Abgleichen",
        "menu-item:File",
        "button:File",
        "button:Choose file",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        let output = fixture
            .command_for_with_timeout(mode, "page-target", "POST", "/v1/click", Some(&body), "100")
            .output()
            .expect("routine click");
        assert!(
            output.status.success(),
            "{mode} asked: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }
}

/// An unnamed control is named from its own hints, never its index (a
/// dogfood prompt read "button 5" for an avatar button). A position
/// outside the fixed vocabulary is dropped, an email address in an image's
/// alt text gives way to the icon noun, and a secret in it is masked in the
/// snapshot, the prompt and the action log.
#[test]
fn unnamed_controls_are_named_from_their_own_hints_never_their_index() {
    for (mode, expected) in [
        ("ff-avatar", "profile picture button in the top right"),
        ("icon-trash", "delete button in the top right"),
        ("image-alt-button", "Profilbild button in the top right"),
        ("tooltip-button", "Einstellungen"),
        ("email-alt", "profile picture button in the top right"),
        ("bogus-position", "unnamed button"),
        ("unnamed-plain", "unnamed button"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot = payload_of(&fixture.run(mode, "GET", "/v1/snapshot", None));
        assert_eq!(
            snapshot["interactiveElements"][0]["label"], expected,
            "{mode}"
        );
    }

    let fixture = EmbeddedControllerFixture::new();
    let snapshot = payload_of(&fixture.run("canary-alt", "GET", "/v1/snapshot", None));
    assert_no_canary("snapshot", &snapshot.to_string());
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]}).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "canary-alt",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert_no_canary("approval label", &requests[0]["display"].to_string());
    assert_no_canary("action log", &fixture.action_log());
}

/// A control is named by what it draws, never by text nothing draws (an svg's
/// metadata, a bare media type), and an unnamed one by its own attributes, its
/// sprite's icon or the short text right beside it (live test, 2026-10-27:
/// "Pesquisa (shown as "image/svg+xml")" and "unnamed button in the top right").
#[test]
fn controls_are_named_by_what_they_draw_and_what_sits_beside_them() {
    for (mode, expected) in [
        ("svg-metadata-search", "Pesquisa"),
        ("svg-metadata-unnamed", "unnamed button in the top right"),
        ("media-type-alt", "unnamed button in the top right"),
        (
            "nearby-text",
            "button next to \u{201c}Idioma\u{201d} in the top right",
        ),
        ("image-input-alt", "Pesquisar"),
        ("sprite-icon", "search button in the top right"),
        ("inner-label", "Lupa button in the top right"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot = payload_of(&fixture.run(mode, "GET", "/v1/snapshot", None));
        assert_eq!(
            snapshot["interactiveElements"][0]["label"], expected,
            "{mode}"
        );
    }

    // The prompt names the control by its name alone: its visible text is
    // nothing it draws, so there is no "(shown as …)".
    let mode = "svg-metadata-search";
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id(mode);
    let (output, requests) = fixture.run_with_decisions(
        mode,
        "page-target",
        "POST",
        "/v1/click",
        Some(&json!({"index": 0, "snapshotId": snapshot_id}).to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    let label = requests[0]["display"]["label"].as_str().unwrap_or_default();
    assert!(label.ends_with("Pesquisa"), "{label}");
    assert!(!label.contains("image/svg+xml"), "{label}");
    assert!(!fixture.action_log().contains("image/svg+xml"));

    // An inner element's label only names the control and never sets the
    // step's category; like any name, its words can still make a routine step
    // ask (the consequential floor), never let one go.
    let mode = "inner-label-risky";
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let snapshot = payload_of(&fixture.call(mode, "GET", "/v1/snapshot", None));
    assert_eq!(
        snapshot["interactiveElements"][0]["label"],
        "Delete account button in the top right"
    );
    let snapshot_id = snapshot["snapshotId"].as_str().expect("snapshot id");
    let (output, requests) = fixture.call_deciding(
        mode,
        "POST",
        "/v1/click",
        Some(&json!({"index": 0, "snapshotId": snapshot_id}).to_string()),
        &["deny"],
    );
    assert!(failure_of(&output).contains("approval_denied"));
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(
        requests[0]["display"]["label"],
        "Change something: Delete account button in the top right"
    );
}

/// A page whose title is only a media type ("image/svg+xml") has no title:
/// the tab list, the snapshot and the action log fall back to its address.
#[test]
fn a_bare_media_type_is_no_page_title() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let mode = "media-type-title";
    let snapshot = payload_of(&fixture.call(mode, "GET", "/v1/snapshot", None));
    assert_eq!(snapshot["title"], "");
    let listed = payload_of(&fixture.call(mode, "GET", "/v1/tabs", None));
    let tab = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.first())
        .cloned()
        .unwrap_or_default();
    assert_eq!(tab["title"], "", "{listed}");
    payload_of(&fixture.call(
        mode,
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/logo.svg"}"#),
    ));
    let log = fixture.action_log();
    assert!(!log.contains("image/svg+xml"), "{log}");
    assert!(log.contains("\"type\":\"nav_result\""), "{log}");
}

/// A menu item whose label records or finalizes something ("Festschreiben",
/// "Buchen", "Als bezahlt markieren", "Speichern", "Mark as paid") is a
/// consequential step, so a routine start still asks before running it.
#[test]
fn a_routine_start_still_asks_for_menu_items_that_record_or_finalize() {
    for mode in [
        "menu-item-finalize",
        "menu-item-book",
        "menu-item-mark-paid",
        "menu-item-save",
        "menu-item-mark-paid-en",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        // "100" fails the prompt this click must publish as unanswered.
        let output = fixture
            .command_for_with_timeout(mode, "page-target", "POST", "/v1/click", Some(&body), "100")
            .output()
            .expect("routine click");
        assert!(!output.status.success(), "{mode} ran without asking");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("approval_timeout_non_retryable"),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !fixture.action_log().contains("\"type\":\"click\""),
            "{mode} clicked"
        );
    }
}

#[test]
fn a_routine_start_still_refuses_the_users_own_steps_without_a_prompt() {
    for (mode, path, extra, code) in [
        ("reveal-key", "/v1/click", json!({}), "step_refused_secret"),
        (
            "sign-in-email",
            "/v1/type",
            json!({"text": "person@example.test"}),
            "step_refused_sign_in",
        ),
        ("file-input", "/v1/click", json!({}), "step_refused_upload"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for(mode, "page-target", "POST", path, Some(&body.to_string())),
            &["allow_once"],
        );
        assert!(!output.status.success(), "{mode}");
        assert!(requests.is_empty(), "{mode} prompted");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(code),
            "{mode}"
        );
    }
}

#[test]
fn a_routine_start_bound_to_another_run_fails_closed() {
    let fixture = EmbeddedControllerFixture::new();
    for (owner_id, run_id) in [
        (Uuid::new_v4(), fixture.run_id),
        (fixture.owner_id, Uuid::new_v4()),
    ] {
        fixture.prepare_authority("page-target", &[]);
        write_routine_approval_state(
            &fixture.approval_dir,
            &owner_id.to_string(),
            run_id,
            fixture.initiator_user_id,
            "page-target",
        )
        .expect("seed a foreign routine start");
        let output = fixture
            .command_for_with_timeout("safe", "page-target", "GET", "/v1/snapshot", None, "100")
            .output()
            .expect("snapshot under a foreign state");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("belongs to another run"));
    }
}

#[test]
fn the_approval_window_agrees_across_the_script_the_tool_and_the_origin() {
    let script_constant = |name: &str| -> u128 {
        let declaration = format!("const {name} = ");
        let line = SHARED_BROWSER_APPROVAL_SCRIPT
            .lines()
            .map(str::trim)
            .find(|line| line.starts_with(&declaration))
            .unwrap_or_else(|| panic!("{name} is declared"));
        line[declaration.len()..]
            .trim_end_matches(';')
            .replace('_', "")
            .parse()
            .unwrap_or_else(|_| panic!("{name} is a number"))
    };
    assert_eq!(
        script_constant("DEFAULT_APPROVAL_WAIT_MS"),
        DEFAULT_APPROVAL_WAIT.as_millis()
    );
    assert_eq!(
        script_constant("MAX_APPROVAL_WAIT_MS"),
        MAX_APPROVAL_WAIT.as_millis()
    );
    // A shorter origin cap would refuse the script's requests unseen.
    assert_eq!(
        u128::from(origin_http_server::SHARED_BROWSER_MAX_APPROVAL_LIFETIME_MS),
        MAX_APPROVAL_WAIT.as_millis()
    );
    assert_eq!(DEFAULT_APPROVAL_WAIT, Duration::from_secs(120));
    assert_eq!(MAX_APPROVAL_WAIT, Duration::from_secs(300));

    assert_eq!(approval_wait_budget(None), DEFAULT_APPROVAL_WAIT);
    assert_eq!(
        approval_wait_budget(Some(" 5000 ")),
        Duration::from_millis(5000)
    );
    assert_eq!(approval_wait_budget(Some("10")), Duration::from_millis(100));
    assert_eq!(approval_wait_budget(Some("900000")), MAX_APPROVAL_WAIT);
    assert_eq!(approval_wait_budget(Some("NaN")), DEFAULT_APPROVAL_WAIT);
    // A value this side cannot read never sizes the tool below the script.
    assert_eq!(approval_wait_budget(Some("soon")), MAX_APPROVAL_WAIT);
}

#[test]
fn a_person_gets_the_full_default_window_to_answer() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority("page-target", &[]);
    let mut command = fixture.command_for("safe", "page-target", "GET", "/v1/snapshot", None);
    command.0.env_remove(APPROVAL_TIMEOUT_MS_ENV);
    let (output, requests) = fixture.decide_prepared(command, &["deny"]);
    assert!(!output.status.success());
    assert_eq!(requests.len(), 1);
    let lifetime = requests[0]["expiresAtMs"].as_u64().unwrap()
        - requests[0]["requestedAtMs"].as_u64().unwrap();
    // Measured from the call's start, so a few milliseconds already passed.
    assert!(
        lifetime <= 120_000 && lifetime > 119_000,
        "lifetime {lifetime}"
    );
}

#[test]
fn a_site_prompt_and_its_step_prompt_share_one_deadline() {
    use std::time::{Duration, Instant};

    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority("page-target", &[]);
    // A risky address on a new site asks for the site, then for the step.
    let mut child = fixture
        .command_for(
            "safe",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://new.example/reports/export.csv"}"#),
        )
        .spawn()
        .expect("spawn Ask-mode navigation");
    let started = Instant::now();
    let mut requests: Vec<JsonValue> = Vec::new();
    while child.try_wait().expect("poll controller").is_none() {
        if let Some(request) = fixture.pending_request()
            && requests
                .last()
                .is_none_or(|last| last["approvalId"] != request["approvalId"])
        {
            if requests.is_empty() {
                // The person takes a while with the site prompt.
                std::thread::sleep(Duration::from_millis(400));
                fixture.answer(&request, "allow_origin");
            } else {
                fixture.answer(&request, "deny");
            }
            requests.push(request);
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "fixture timed out"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let output = child.wait_with_output().expect("controller output");
    assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["kind"], "origin");
    assert_eq!(requests[1]["kind"], "action");
    // The step prompt ends when the site prompt would have: the late answer
    // did not buy the call a second full window.
    assert_eq!(requests[1]["expiresAtMs"], requests[0]["expiresAtMs"]);
    let step_window = requests[1]["expiresAtMs"].as_u64().unwrap()
        - requests[1]["requestedAtMs"].as_u64().unwrap();
    assert!(step_window <= 5_000 - 400, "step window {step_window}");
}

#[test]
fn an_unanswered_prompt_ends_the_turn_without_reading_as_a_denial() {
    let unanswered = terminal_consent_call_result("approval_timeout");
    assert_ne!(unanswered.is_error, Some(true));
    let text = serde_json::to_string(&unanswered.content).expect("content JSON");
    assert!(text.contains("has not answered"), "{text}");
    assert!(text.contains("End this turn now"), "{text}");
    assert!(text.contains("do not retry"), "{text}");
    let signal = unanswered
        .structured_content
        .expect("terminal consent signal")["terminalConsent"]
        .clone();
    assert_eq!(
        signal,
        json!({
            "state": "blocked",
            "terminal": true,
            "retryable": false,
            "code": "approval_timeout",
        })
    );

    let denied = terminal_consent_call_result("approval_denied");
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(
        denied.structured_content.expect("terminal consent signal")["terminalConsent"]["code"],
        "approval_denied"
    );
}

#[tokio::test]
async fn an_unanswered_prompt_still_blocks_every_later_browser_call() {
    let server = SharedBrowserMcpServer::new();
    let click = mcp_tool_request(
        "click",
        json!({ "index": 0, "snapshotId": SNAPSHOT_ID })
            .as_object()
            .cloned(),
    )
    .unwrap();
    let first = server
        .execute_with_failure_latch(&click, || async {
            Err(anyhow::anyhow!(
                "Shared Browser approval timed out [approval_timeout_non_retryable]"
            ))
        })
        .await;
    assert!(matches!(
        first,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_timeout"
        ))
    ));
    let navigate = mcp_tool_request(
        "navigate",
        json!({ "url": "https://example.test/" })
            .as_object()
            .cloned(),
    )
    .unwrap();
    let later = server
        .execute_with_failure_latch(&navigate, || async {
            panic!("an unanswered prompt must not open another one in this turn")
        })
        .await;
    assert!(matches!(
        later,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_timeout"
        ))
    ));
}

// Octo's own tabs: up to three visible tabs next to the page the person chose,
// each bound to its own approvals, read-only, never on a link-only site, and
// closed when the run ends unless the person kept them.

impl EmbeddedControllerFixture {
    /// Runs one controller command against the authority already prepared,
    /// keeping the run's approval files (and Octo's tabs) from earlier calls.
    fn call(&self, mode: &str, method: &str, path: &str, body: Option<&str>) -> Output {
        self.command_for(mode, "page-target", method, path, body)
            .output()
            .expect("run embedded Shared Browser controller")
    }

    fn call_deciding(
        &self,
        mode: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
        decisions: &[&str],
    ) -> (Output, Vec<JsonValue>) {
        self.decide_prepared(
            self.command_for(mode, "page-target", method, path, body),
            decisions,
        )
    }

    fn open_tab(&self, url: &str) -> JsonValue {
        payload_of(&self.call(
            "safe",
            "POST",
            "/v1/tabs/open",
            Some(&json!({ "url": url }).to_string()),
        ))
    }

    fn tab_record(&self) -> JsonValue {
        serde_json::from_slice(
            &std::fs::read(self.approval_dir.join("tabs.json")).expect("tab record"),
        )
        .expect("tab record JSON")
    }

    fn browser_tabs(&self) -> Vec<String> {
        let raw = std::fs::read(&self.opened_tabs).unwrap_or_else(|_| b"[]".to_vec());
        serde_json::from_slice::<Vec<JsonValue>>(&raw)
            .expect("fake browser tabs")
            .iter()
            .map(|tab| tab["targetId"].as_str().expect("tab id").to_string())
            .collect()
    }

    fn write_kept_tabs(&self, tab_ids: &[&str]) {
        let path = self.approval_dir.join("kept-tabs.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "version": 1,
                "ownerId": self.owner_id,
                "runId": self.run_id,
                "initiatorUserId": self.initiator_user_id,
                "browserPageId": "page-target",
                "tabIds": tab_ids,
            }))
            .expect("kept tabs JSON"),
        )
        .expect("write kept tabs");
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("protect kept tabs");
    }
}

fn failure_of(output: &Output) -> String {
    assert!(
        !output.status.success(),
        "the command should have failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn octo_opens_at_most_three_visible_tabs_and_acts_only_in_its_own_and_the_run_page() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");

    let mut tab_ids = Vec::new();
    for number in 1..=3 {
        let opened = fixture.open_tab(&format!("https://example.test/report-{number}"));
        assert_eq!(opened["openedTab"], true);
        assert_eq!(
            opened["url"],
            format!("https://example.test/report-{number}")
        );
        assert_eq!(opened["browserPageId"], "page-target");
        let tab_id = opened["tabId"].as_str().expect("new tab id").to_string();
        // The tab Octo works in is the one in front, where viewers see it.
        assert_eq!(
            std::fs::read_to_string(&fixture.front_tab).expect("front tab"),
            tab_id
        );
        tab_ids.push(tab_id);
    }
    let fourth = failure_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/open",
        Some(r#"{"url":"https://example.test/report-4"}"#),
    ));
    assert!(fourth.contains("already has 3 tabs open"), "{fourth}");
    assert_eq!(fixture.browser_tabs(), tab_ids, "no fourth tab was opened");

    let listed = payload_of(&fixture.call("safe", "GET", "/v1/tabs", None));
    assert_eq!(listed["agentTabLimit"], 3);
    assert_eq!(listed["agentTabsOpen"], 3);
    let tabs = listed["tabs"].as_array().expect("tabs");
    assert_eq!(tabs.len(), 4);
    assert_eq!(tabs[0]["tabId"], "page-target");
    assert_eq!(tabs[0]["openedBy"], "person");
    for (tab, tab_id) in tabs[1..].iter().zip(&tab_ids) {
        assert_eq!(tab["tabId"], tab_id.as_str());
        assert_eq!(tab["openedBy"], "octo");
    }
    assert_eq!(tabs[3]["current"], true);
    assert_eq!(tabs[0]["current"], false);

    // The action feed attributes each step to the tab it ran in.
    let actions = fixture.action_log();
    let navigation = actions
        .lines()
        .map(|line| serde_json::from_str::<JsonValue>(line).expect("action"))
        .filter(|action| action["type"] == "navigate")
        .collect::<Vec<_>>();
    assert_eq!(navigation.len(), 3);
    for (action, tab_id) in navigation.iter().zip(&tab_ids) {
        assert_eq!(action["pageId"], tab_id.as_str());
    }

    // snapshot and navigate may name their tab; results from Octo's tabs say
    // which tab they come from, results from the run's page do not.
    let in_first = payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/snapshot",
        Some(&json!({ "tabId": tab_ids[0] }).to_string()),
    ));
    assert_eq!(in_first["tabId"], tab_ids[0].as_str());
    assert_eq!(in_first["url"], "https://example.test/report-1");
    let on_run_page = payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/snapshot",
        Some(r#"{"tabId":"page-target"}"#),
    ));
    assert!(on_run_page.get("tabId").is_none());
    assert_eq!(fixture.tab_record()["currentTabId"], JsonValue::Null);

    // A snapshot of one tab is never a target in another.
    let stale = failure_of(&fixture.call(
        "safe",
        "POST",
        "/v1/click",
        Some(&json!({ "index": 0, "snapshotId": in_first["snapshotId"] }).to_string()),
    ));
    assert!(stale.contains("snapshot is stale"), "{stale}");

    // Another tab of the browser is not Octo's to use or close.
    let other = failure_of(&fixture.call(
        "other-tab",
        "POST",
        "/v1/tabs/select",
        Some(r#"{"tabId":"decoy-target"}"#),
    ));
    assert!(other.contains("only the page the person chose"), "{other}");
    let close_run_page = failure_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/close",
        Some(r#"{"tabId":"page-target"}"#),
    ));
    assert!(
        close_run_page.contains("close only the tabs it opened"),
        "{close_run_page}"
    );

    let closed = payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/close",
        Some(&json!({ "tabId": tab_ids[1] }).to_string()),
    ));
    assert_eq!(closed["closedTabId"], tab_ids[1].as_str());
    assert_eq!(closed["agentTabsOpen"], 2);
    assert_eq!(
        fixture.browser_tabs(),
        vec![tab_ids[0].clone(), tab_ids[2].clone()]
    );
    // A closed slot can be used again.
    fixture.open_tab("https://example.test/report-5");
    assert_eq!(fixture.browser_tabs().len(), 3);
}

#[test]
fn a_site_approved_in_one_of_octos_tabs_holds_in_that_tab_only() {
    let fixture = EmbeddedControllerFixture::new();
    // The person approved another site on their page; it opens nothing in
    // Octo's tabs.
    fixture.prepare_authority("page-target", &["https://decoy.example.test"]);
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/tabs/open",
        Some(r#"{"url":"https://example.test/report"}"#),
        &["allow_origin", "allow_once"],
    );
    let opened = payload_of(&output);
    assert!(opened["tabId"].as_str().is_some(), "tab id");
    // One prompt: the site in the new tab, naming the address it opens and
    // bound to it. The site's approval in the tab covers opening it.
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0]["kind"], "origin");
    assert_eq!(requests[0]["browserPageId"], "page-target");
    assert_eq!(
        requests[0]["display"]["label"],
        "Octo's tab 1: Open https://example.test/report in a new tab"
    );
    assert_eq!(
        requests[0]["destinationFingerprint"],
        json!(approval_test_sha256("https://example.test/report"))
    );

    let record = fixture.tab_record();
    assert_eq!(
        record["tabs"][0]["approvedOrigins"],
        json!(["https://example.test"])
    );
    let state: JsonValue = serde_json::from_slice(
        &std::fs::read(fixture.approval_dir.join("state.json")).expect("state"),
    )
    .expect("state JSON");
    assert_eq!(
        state["approvedOrigins"],
        json!(["https://decoy.example.test"])
    );

    // The run's page shows example.test too, but that site is approved in
    // Octo's tab only.
    let on_run_page = payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/select",
        Some(r#"{"tabId":"page-target"}"#),
    ));
    assert_eq!(on_run_page["tabs"][0]["originApproved"], false);
    assert_eq!(on_run_page["tabs"][0]["url"], JsonValue::Null);
    assert_eq!(on_run_page["tabs"][1]["originApproved"], true);
    let status = payload_of(&fixture.call("safe", "GET", "/v1/status", None));
    assert_eq!(status["originApproved"], false);
    assert_eq!(status["agentTabCount"], 1);
}

fn approval_test_sha256(value: &str) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(value.as_bytes()))
}

#[test]
fn a_denied_or_unanswered_new_tab_is_closed_again() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority("page-target", &[]);
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/tabs/open",
        Some(r#"{"url":"https://example.test/report"}"#),
        &["deny"],
    );
    let error = failure_of(&output);
    assert!(error.contains("[site_declined]"), "{error}");
    assert_eq!(requests.len(), 1);
    assert!(
        fixture.browser_tabs().is_empty(),
        "the blank tab was closed"
    );
    assert_eq!(fixture.tab_record()["tabs"], json!([]));
    assert_eq!(fixture.tab_record()["currentTabId"], JsonValue::Null);
}

#[test]
fn a_plain_navigation_to_a_site_approved_in_its_tab_asks_nothing() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority(
        "page-target",
        &["https://example.test", "https://destination.example"],
    );
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://destination.example/en/places/belem-tower"}"#),
        &[],
    );
    assert_eq!(
        payload_of(&output)["url"],
        "https://destination.example/en/places/belem-tower"
    );
    assert!(requests.is_empty(), "{requests:?}");

    // A risky address on an approved site still asks for the step, and the
    // prompt names the address.
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/reports/export.csv"}"#),
        &["deny"],
    );
    assert!(failure_of(&output).contains("approval_denied_non_retryable"));
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0]["kind"], "action");
    assert_eq!(
        requests[0]["display"]["label"],
        "Download or export: Go to https://example.test/reports/export.csv"
    );
}

#[test]
fn a_declined_site_stays_closed_and_the_run_takes_another_route_until_a_second_decline() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority("page-target", &["https://example.test"]);
    // The person declines the search engine Octo chose.
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://search.example/?q=belem+tower"}"#),
        &["deny"],
    );
    let error = failure_of(&output);
    assert_eq!(requests.len(), 1);
    assert!(error.contains("[site_declined]"), "{error}");
    assert!(error.contains("Take another route"), "{error}");
    assert!(!error.contains("_non_retryable"), "{error}");
    // Not a code that ends the run.
    assert_eq!(
        terminal_consent_failure_code_from_error(&anyhow!(error.clone())),
        None
    );
    let state: JsonValue = serde_json::from_slice(
        &std::fs::read(fixture.approval_dir.join("state.json")).expect("state"),
    )
    .expect("state JSON");
    assert_eq!(state["declinedOrigins"], json!(["https://search.example"]));

    // The declined site is not asked for again in this run.
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://search.example/other"}"#),
        &["allow_origin"],
    );
    assert!(failure_of(&output).contains("[site_declined]"));
    assert!(requests.is_empty(), "{requests:?}");

    // Another route that fits the request: the site the person named.
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://tourism.example/en"}"#),
        &["allow_origin"],
    );
    assert_eq!(payload_of(&output)["url"], "https://tourism.example/en");
    assert_eq!(requests.len(), 1);

    // Declining a second site ends the run.
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://other.example/"}"#),
        &["deny"],
    );
    assert_eq!(requests.len(), 1);
    assert!(failure_of(&output).contains("approval_denied_non_retryable"));
}

/// Writes the run's approval state the way the approval script does, for the
/// run that holds `marker_path`.
fn write_run_state(marker_path: &Path, approval_dir: &Path, approved: &[&str], routine: bool) {
    let marker: JsonValue =
        serde_json::from_slice(&std::fs::read(marker_path).expect("marker")).expect("marker JSON");
    let state_path = approval_dir.join("state.json");
    std::fs::write(
        &state_path,
        serde_json::to_vec(&json!({
            "version": 1,
            "ownerId": marker["ownerId"],
            "runId": marker["runId"],
            "initiatorUserId": marker["initiatorUserId"],
            "browserPageId": marker["browserPageId"],
            "approvedOrigins": approved,
            "consumedApprovalIds": [],
            "routineBrowsingAllowed": routine,
        }))
        .expect("state JSON"),
    )
    .expect("write state");
    #[cfg(unix)]
    std::fs::set_permissions(&state_path, std::fs::Permissions::from_mode(0o600))
        .expect("protect state");
}

#[tokio::test]
async fn a_run_keeps_the_last_runs_approvals_only_when_it_continues_that_run_for_the_same_person_and_page()
 {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    let person = Uuid::new_v4();
    let acquire = |run_id: Uuid, person: Uuid, page: &str, continues: Option<Uuid>| {
        let cancel_signal = JobCancelSignal::new();
        let guard = SharedBrowserAgentControlGuard::acquire_continuing(
            path.clone(),
            approval_dir.clone(),
            ApprovalStart::Ask,
            run_id,
            person,
            page,
            "Octo",
            continues,
            &[],
            cancel_signal.clone(),
            Duration::from_secs(60),
        )
        .expect("acquire run");
        (guard, cancel_signal)
    };
    let end = |(guard, cancel_signal): (SharedBrowserAgentControlGuard, JobCancelSignal)| {
        cancel_signal.confirm_shared_browser_shutdown();
        drop(guard);
    };
    let state = || -> Option<JsonValue> {
        std::fs::read(approval_dir.join("state.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).expect("state JSON"))
    };

    // The person approves a site on their page and allows routine browsing,
    // then takes over: the run ends.
    let first = Uuid::new_v4();
    let run = acquire(first, person, "page-target", None);
    write_run_state(&path, &approval_dir, &["https://example.test"], true);
    end(run);
    assert!(state().is_none(), "the run's own records are revoked");

    // Let Octo continue names that run: the new run starts with its grants,
    // bound to the new run.
    let second = Uuid::new_v4();
    let run = acquire(second, person, "page-target", Some(first));
    let marker: JsonValue =
        serde_json::from_slice(&std::fs::read(&path).expect("marker")).expect("marker JSON");
    let carried = state().expect("carried state");
    assert_eq!(carried["approvedOrigins"], json!(["https://example.test"]));
    assert_eq!(carried["routineBrowsingAllowed"], true);
    assert_eq!(carried["consumedApprovalIds"], json!([]));
    for key in ["ownerId", "runId", "initiatorUserId", "browserPageId"] {
        assert_eq!(carried[key], marker[key], "{key}");
    }
    assert_eq!(carried["runId"], second.to_string());
    end(run);

    // Only the last run can be continued: naming an earlier one carries
    // nothing.
    let run = acquire(Uuid::new_v4(), person, "page-target", Some(first));
    assert!(state().is_none());
    end(run);

    // Another page, another person, an unnamed continuation, a run in
    // between or a record that is too old carry nothing.
    let cases: [(&str, Uuid, bool, bool, bool); 5] = [
        ("other-page", person, true, false, false),
        ("page-target", Uuid::new_v4(), true, false, false),
        ("page-target", person, false, false, false),
        ("page-target", person, true, true, false),
        ("page-target", person, true, false, true),
    ];
    for (page, who, named, run_in_between, too_old) in cases {
        let ended = Uuid::new_v4();
        let run = acquire(ended, person, "page-target", None);
        write_run_state(&path, &approval_dir, &["https://example.test"], false);
        end(run);
        if run_in_between {
            end(acquire(Uuid::new_v4(), person, "page-target", None));
        }
        if too_old {
            with_ended_run_grants(|records| {
                let record = records.get_mut(&approval_dir).expect("ended run record");
                record.ended_at = std::time::Instant::now()
                    .checked_sub(CONTINUATION_WINDOW + Duration::from_secs(1))
                    .expect("an earlier instant");
            });
        }
        let run = acquire(Uuid::new_v4(), who, page, named.then_some(ended));
        assert!(
            state().is_none(),
            "{page} {who} named={named} between={run_in_between} old={too_old}"
        );
        end(run);
    }

    // A state that is not the run's own leaves nothing to carry.
    let ended = Uuid::new_v4();
    let run = acquire(ended, person, "page-target", None);
    write_run_state(&path, &approval_dir, &["https://example.test/path"], false);
    end(run);
    let run = acquire(Uuid::new_v4(), person, "page-target", Some(ended));
    assert!(state().is_none());
    end(run);
}

#[tokio::test]
async fn let_ai_continue_keeps_the_site_the_person_approved_and_a_fresh_turn_asks_again() {
    let fixture = EmbeddedControllerFixture::new();
    // The fixture answers prompts as this person.
    let person = fixture.initiator_user_id;
    let acquire = |run_id: Uuid, continues: Option<Uuid>| {
        let cancel_signal = JobCancelSignal::new();
        let guard = SharedBrowserAgentControlGuard::acquire_continuing(
            fixture.authority_path.clone(),
            fixture.approval_dir.clone(),
            ApprovalStart::Ask,
            run_id,
            person,
            "page-target",
            "Octo",
            continues,
            &[],
            cancel_signal.clone(),
            Duration::from_secs(60),
        )
        .expect("acquire run");
        (guard, cancel_signal)
    };
    let end = |(guard, cancel_signal): (SharedBrowserAgentControlGuard, JobCancelSignal)| {
        cancel_signal.confirm_shared_browser_shutdown();
        drop(guard);
    };
    let navigate = |url: &str, decisions: &[&str]| {
        let (output, requests) = fixture.call_deciding(
            "safe",
            "POST",
            "/v1/navigate",
            Some(&json!({ "url": url }).to_string()),
            decisions,
        );
        (payload_of(&output), requests)
    };

    // Octo asks for the transport site; the person allows it, then takes over.
    let first = Uuid::new_v4();
    let run = acquire(first, None);
    let (_, requests) = navigate("https://transport.example/lines", &["allow_origin"]);
    assert_eq!(requests.len(), 1);
    end(run);

    // Let Octo continue: the approved site opens without asking again.
    let run = acquire(Uuid::new_v4(), Some(first));
    let (page, requests) = navigate("https://transport.example/tram-15", &[]);
    assert_eq!(page["url"], "https://transport.example/tram-15");
    assert!(requests.is_empty(), "{requests:?}");
    end(run);

    // A fresh turn that continues nothing asks again.
    let run = acquire(Uuid::new_v4(), None);
    let (_, requests) = navigate("https://transport.example/tram-15", &["allow_origin"]);
    assert_eq!(requests.len(), 1);
    end(run);
}

#[test]
fn the_continued_run_is_read_from_studio_metadata_and_nothing_else_names_one() {
    let run = Uuid::new_v4();
    assert_eq!(
        continued_run_id_from_payload(
            &json!({ "metadata": { "browserContinuesRunId": run.to_string() } })
        ),
        Some(run)
    );
    for payload in [
        json!({}),
        json!({ "metadata": {} }),
        json!({ "metadata": { "browserContinuesRunId": "not-a-run" } }),
        json!({ "metadata": { "browserContinuesRunId": 7 } }),
        json!({ "browserContinuesRunId": run.to_string() }),
    ] {
        assert_eq!(continued_run_id_from_payload(&payload), None, "{payload}");
    }
}

#[test]
fn octos_tabs_are_for_reading_and_refuse_every_other_step_before_any_prompt() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let tab = fixture.open_tab("https://example.test/report");
    let tab_id = tab["tabId"].as_str().expect("tab id").to_string();
    let snapshot_in = |mode: &str| {
        payload_of(&fixture.call(mode, "GET", "/v1/snapshot", None))["snapshotId"]
            .as_str()
            .expect("snapshot id")
            .to_string()
    };

    for (mode, path, extra) in [
        ("form-submit-input", "/v1/click", json!({})),
        ("save-button", "/v1/click", json!({})),
        ("export-link", "/v1/click", json!({})),
        ("invite-button", "/v1/click", json!({})),
        (
            "safe",
            "/v1/type",
            json!({ "text": "hotels near the station", "submit": true }),
        ),
        ("safe", "/v1/press", json!({ "key": "Enter" })),
    ] {
        let snapshot_id = snapshot_in(mode);
        let mut body = json!({ "index": 0, "snapshotId": snapshot_id });
        for (key, value) in extra.as_object().expect("extra") {
            body[key] = value.clone();
        }
        let (output, requests) =
            fixture.call_deciding(mode, "POST", path, Some(&body.to_string()), &["allow_once"]);
        let error = failure_of(&output);
        assert!(error.contains("for reading"), "{mode} {path}: {error}");
        assert!(requests.is_empty(), "{mode} {path} asked: {requests:?}");
    }
    assert!(
        !fixture.click_log.exists(),
        "no control was clicked in Octo's tab"
    );
    let snapshot_id = snapshot_in("safe");
    let human_input = failure_of(&fixture.call(
        "safe",
        "POST",
        "/v1/request-human-input",
        Some(&json!({ "indices": [0], "snapshotId": snapshot_id }).to_string()),
    ));
    assert!(human_input.contains("for reading"), "{human_input}");
    let risky = failure_of(&fixture.call(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/logout"}"#),
    ));
    assert!(risky.contains("for reading"), "{risky}");

    // Reading steps still run there: typing that does not submit, a plain click.
    let typed = payload_of(
        &fixture.call(
            "safe",
            "POST",
            "/v1/type",
            Some(
                &json!({ "index": 0, "snapshotId": snapshot_in("safe"), "text": "station" })
                    .to_string(),
            ),
        ),
    );
    assert_eq!(typed["tabId"], tab_id.as_str());
    payload_of(&fixture.call(
        "plain-button",
        "POST",
        "/v1/click",
        Some(&json!({ "index": 0, "snapshotId": snapshot_in("plain-button") }).to_string()),
    ));
}

#[test]
fn octos_tab_that_moved_itself_onto_a_link_only_site_is_not_read() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let tab_id = fixture.open_tab("https://example.test/report")["tabId"]
        .as_str()
        .expect("tab id")
        .to_string();
    // The page moves itself on (a timed redirect) between Octo's steps.
    std::fs::write(
        &fixture.opened_tabs,
        json!([{ "targetId": tab_id, "url": "https://www.booking.com/hotel/fixture.html" }])
            .to_string(),
    )
    .expect("move the tab");

    for (method, path, body) in [
        ("GET", "/v1/snapshot", None),
        ("GET", "/v1/status", None),
        ("POST", "/v1/scroll", Some(r#"{"x":0,"y":720}"#)),
    ] {
        let refused = failure_of(&fixture.call("safe", method, path, body));
        assert!(
            refused.contains("Booking.com, which is link-only, so nothing there was read"),
            "{path}: {refused}"
        );
    }
    let listed = payload_of(&fixture.call("safe", "GET", "/v1/tabs", None));
    let tab = &listed["tabs"][1];
    assert_eq!(tab["linkOnlySite"], "Booking.com");
    assert_eq!(tab["title"], JsonValue::Null);
    assert_eq!(tab["url"], JsonValue::Null);

    // Octo may still take the tab elsewhere.
    let back = payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/report"}"#),
    ));
    assert_eq!(back["url"], "https://example.test/report");
}

#[test]
fn octos_tabs_never_open_a_link_only_site() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let refused = failure_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/open",
        Some(r#"{"url":"https://www.booking.com/hotel/fixture.html"}"#),
    ));
    assert!(refused.contains("Booking.com is link-only"), "{refused}");
    assert!(fixture.browser_tabs().is_empty(), "no tab was opened");

    fixture.open_tab("https://example.test/report");
    for url in ["https://www.airbnb.co.uk/rooms/1", "https://amazon.de/dp/1"] {
        let error = failure_of(&fixture.call(
            "safe",
            "POST",
            "/v1/navigate",
            Some(&json!({ "url": url }).to_string()),
        ));
        assert!(error.contains("is link-only"), "{url}: {error}");
    }
    let snapshot_id =
        payload_of(&fixture.call("link-only-link", "GET", "/v1/snapshot", None))["snapshotId"]
            .as_str()
            .expect("snapshot id")
            .to_string();
    let link = failure_of(&fixture.call(
        "link-only-link",
        "POST",
        "/v1/click",
        Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
    ));
    assert!(link.contains("Booking.com is link-only"), "{link}");
    assert!(!fixture.click_log.exists());
    assert!(
        !std::fs::read_to_string(&fixture.opened_tabs)
            .expect("tabs")
            .contains("booking"),
        "no tab ever loaded a link-only site"
    );
}

#[test]
fn a_tab_the_person_closed_or_kept_is_no_longer_octos_to_use_or_close() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let first = fixture.open_tab("https://example.test/one")["tabId"]
        .as_str()
        .expect("tab id")
        .to_string();
    let second = fixture.open_tab("https://example.test/two")["tabId"]
        .as_str()
        .expect("tab id")
        .to_string();

    fixture.write_kept_tabs(&[first.as_str()]);
    let kept = failure_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/close",
        Some(&json!({ "tabId": first }).to_string()),
    ));
    assert!(kept.contains("kept this tab open"), "{kept}");
    let listed = payload_of(&fixture.call("safe", "GET", "/v1/tabs", None));
    assert_eq!(listed["tabs"][1]["keptByPerson"], true);
    assert!(listed["tabs"][2].get("keptByPerson").is_none());

    // The person closes the tab Octo is working in.
    std::fs::write(
        &fixture.opened_tabs,
        json!([{ "targetId": first, "url": "https://example.test/one" }]).to_string(),
    )
    .expect("person closes a tab");
    let snapshot = failure_of(&fixture.call("safe", "GET", "/v1/snapshot", None));
    assert!(
        snapshot.contains("was closed, so nothing was done"),
        "{snapshot}"
    );
    assert!(
        !fixture.tab_record().to_string().contains(second.as_str()),
        "a closed tab leaves the run's record"
    );
    // Back on the run's page, with the other tab still Octo's.
    let listed = payload_of(&fixture.call("safe", "GET", "/v1/tabs", None));
    assert_eq!(listed["tabs"].as_array().expect("tabs").len(), 2);
    assert_eq!(listed["tabs"][0]["current"], true);
}

#[test]
fn tab_tools_map_to_bounded_controller_requests() {
    let object = |value: JsonValue| value.as_object().cloned();
    let snapshot = mcp_tool_request("snapshot", None).expect("snapshot");
    assert_eq!(
        (snapshot.method.as_str(), snapshot.path.as_str()),
        ("GET", "/v1/snapshot")
    );
    let in_tab =
        mcp_tool_request("snapshot", object(json!({ "tabId": "TAB-1" }))).expect("tab snapshot");
    assert_eq!(
        (in_tab.method.as_str(), in_tab.path.as_str()),
        ("POST", "/v1/snapshot")
    );
    let listed = mcp_tool_request("list_tabs", None).expect("list");
    assert_eq!(
        (listed.method.as_str(), listed.path.as_str()),
        ("GET", "/v1/tabs")
    );
    for (name, path) in [
        ("select_tab", "/v1/tabs/select"),
        ("close_tab", "/v1/tabs/close"),
    ] {
        let request = mcp_tool_request(name, object(json!({ "tabId": "TAB_1" }))).expect(name);
        assert_eq!(request.path, path);
        assert!(mcp_tool_request(name, None).is_err(), "{name} needs a tab");
        for bad in [
            json!(" TAB"),
            json!("../TAB"),
            json!(7),
            json!("a".repeat(257)),
        ] {
            assert!(
                mcp_tool_request(name, object(json!({ "tabId": bad }))).is_err(),
                "{name} {bad}"
            );
        }
    }
    let opened = mcp_tool_request(
        "open_tab",
        object(json!({ "url": "https://example.test/a" })),
    )
    .expect("open");
    assert_eq!(opened.path, "/v1/tabs/open");
    for bad in [
        json!({ "url": "/reports" }),
        json!({ "url": "file:///etc/passwd" }),
        json!({ "url": "https://user:secret@example.test/" }),
        json!({ "url": "https://example.test/", "tabId": "TAB" }),
    ] {
        assert!(
            mcp_tool_request("open_tab", object(bad.clone())).is_err(),
            "{bad}"
        );
    }
    assert!(
        mcp_tool_request(
            "navigate",
            object(json!({ "url": "https://example.test/", "tabId": "TAB" }))
        )
        .is_ok()
    );
    assert!(mcp_tool_request("list_tabs", object(json!({ "tabId": "TAB" }))).is_err());
    assert!(
        mcp_tool_request(
            "snapshot",
            object(json!({ "tabId": "TAB", "evaluate": "x" }))
        )
        .is_err()
    );
    assert!(parse_request_args(&strings(&["request", "GET", "/v1/tabs"])).is_ok());
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/tabs/open",
            r#"{"url":"https://example.test/"}"#
        ]))
        .is_ok()
    );
    assert!(parse_request_args(&strings(&["request", "POST", "/v1/tabs/new", "{}"])).is_err());
}

#[test]
fn the_devtools_address_for_closing_tabs_is_loopback_only() {
    assert_eq!(
        cdp_endpoint_from(None, None),
        Some(("127.0.0.1".to_string(), 9223))
    );
    assert_eq!(
        cdp_endpoint_from(None, Some("19223")),
        Some(("127.0.0.1".to_string(), 19223))
    );
    assert_eq!(
        cdp_endpoint_from(Some("http://localhost:9300"), Some("1")),
        Some(("127.0.0.1".to_string(), 9300))
    );
    assert_eq!(
        cdp_endpoint_from(Some("ws://[::1]:9301/devtools/browser/x"), None),
        Some(("[::1]".to_string(), 9301))
    );
    for refused in [
        "http://10.0.0.4:9223",
        "http://browser.internal:9223",
        "https://127.0.0.1:9223",
        "http://user:pass@127.0.0.1:9223",
    ] {
        assert_eq!(cdp_endpoint_from(Some(refused), None), None, "{refused}");
    }
    assert_eq!(cdp_endpoint_from(None, Some("not-a-port")), None);
}

/// A loopback stand-in for Chromium's DevTools HTTP endpoint that records
/// the request line of every connection.
fn fake_devtools() -> (std::net::SocketAddr, Arc<std::sync::Mutex<Vec<String>>>) {
    use std::io::{BufRead, BufReader};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("fake devtools");
    let address = listener.local_addr().expect("fake devtools address");
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().expect("stream"));
            if reader.read_line(&mut line).is_ok() {
                seen.lock().expect("requests").push(line.trim().to_string());
            }
            let _ =
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\nTarget is closing");
        }
    });
    (address, requests)
}

fn write_run_record(
    approval_dir: &Path,
    name: &str,
    guard: &SharedBrowserAgentControlGuard,
    extra: JsonValue,
) {
    let mut record = json!({
        "version": 1,
        "ownerId": guard.owner_id,
        "runId": guard.run_id,
        "initiatorUserId": guard.initiator_user_id,
        "browserPageId": guard.browser_page_id,
    });
    for (key, value) in extra.as_object().expect("extra") {
        record[key] = value.clone();
    }
    let path = approval_dir.join(name);
    std::fs::write(&path, serde_json::to_vec(&record).expect("record")).expect("write record");
    #[cfg(unix)]
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("protect");
}

#[tokio::test]
async fn the_end_of_a_run_closes_octos_tabs_apart_from_those_the_person_kept() {
    let (address, requests) = fake_devtools();
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    let acquire = || {
        let cancel_signal = JobCancelSignal::new();
        let mut guard = SharedBrowserAgentControlGuard::acquire_with_path(
            directory.path().join("agent-control.json"),
            approval_dir.clone(),
            ApprovalStart::Routine,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "page-target",
            "Octo",
            cancel_signal.clone(),
            Duration::from_secs(60),
        )
        .expect("acquire run");
        guard.cdp_base = Some(("127.0.0.1".to_string(), address.port()));
        (guard, cancel_signal)
    };

    let (guard, cancel_signal) = acquire();
    write_run_record(
        &approval_dir,
        "tabs.json",
        &guard,
        json!({
            "currentTabId": "TAB-B",
            "tabs": [
                { "tabId": "TAB-A", "approvedOrigins": [] },
                { "tabId": "TAB-B", "approvedOrigins": [] },
                { "tabId": "TAB-C", "approvedOrigins": [] }
            ]
        }),
    );
    write_run_record(
        &approval_dir,
        "kept-tabs.json",
        &guard,
        json!({ "tabIds": ["TAB-B"] }),
    );
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert_eq!(
        *requests.lock().expect("requests"),
        vec![
            "GET /json/close/TAB-A HTTP/1.1".to_string(),
            "GET /json/close/TAB-C HTTP/1.1".to_string(),
        ]
    );
    assert!(!approval_dir.join("tabs.json").exists());

    // A record bound to another run names no tab of this one.
    requests.lock().expect("requests").clear();
    let (guard, cancel_signal) = acquire();
    let other_run = json!({
        "version": 1,
        "ownerId": Uuid::new_v4().to_string(),
        "runId": guard.run_id,
        "initiatorUserId": guard.initiator_user_id,
        "browserPageId": "page-target",
        "currentTabId": null,
        "tabs": [{ "tabId": "TAB-D", "approvedOrigins": [] }]
    });
    std::fs::write(approval_dir.join("tabs.json"), other_run.to_string()).expect("write");
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert!(requests.lock().expect("requests").is_empty());

    // Without a confirmed shutdown nothing is closed: the run's tools may
    // still be running, and the runtime is recycled instead.
    let (guard, _cancel_signal) = acquire();
    write_run_record(
        &approval_dir,
        "tabs.json",
        &guard,
        json!({ "currentTabId": null, "tabs": [{ "tabId": "TAB-E", "approvedOrigins": [] }] }),
    );
    drop(guard);
    assert!(requests.lock().expect("requests").is_empty());
}

/// A loopback stand-in for Chromium's DevTools HTTP endpoint whose tab list
/// (`/json/list`) shows the run's page at `run_page_url`; every other request
/// succeeds. It records the request line of every connection.
fn devtools_listing_run_page(run_page_url: &str) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    devtools_listing(json!([
        { "id": "TAB-OTHER-CHAT", "type": "page", "url": "https://roborock.example/" },
        { "id": "page-target", "type": "page", "url": run_page_url },
        { "id": "TAB-A", "type": "page", "url": "https://metro.example/maps" },
        { "id": "TAB-B", "type": "page", "url": "https://trams.example/planner" }
    ]))
}

/// A loopback DevTools endpoint that lists these tabs, and records each
/// request it answers.
fn devtools_listing(list: JsonValue) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    use std::io::{BufRead, BufReader};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("fake devtools");
    let port = listener.local_addr().expect("fake devtools address").port();
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    let list = list.to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().expect("stream"));
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let line = line.trim().to_string();
            let body = if line.starts_with("GET /json/list ") {
                list.clone()
            } else {
                String::new()
            };
            seen.lock().expect("requests").push(line);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        }
    });
    (port, requests)
}

/// A browser turn that read only in its own tabs, while the chat's own tab
/// (the run's page) stayed blank: the tab it worked in last stays open as the
/// chat's page, untouched (a cookie banner it refused stays refused), and
/// comes to the front. Without this, every tab Octo read closed and Chromium
/// showed its neighbour, another chat's page.
///
/// The chat tab record names that tab with its run, and outlives the run, so
/// Studio finds the chat's page after a reload, on another device or for
/// another member too, not only in a page that watched the turn.
#[tokio::test]
async fn a_run_that_read_only_in_its_own_tabs_leaves_the_last_one_as_the_chats_page() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    let chat_tabs = || -> JsonValue {
        serde_json::from_slice(
            &std::fs::read(approval_dir.join("chat-tabs.json")).expect("chat tabs"),
        )
        .expect("chat tabs JSON")
    };
    let end_run = |run_page_url: &str, current: JsonValue| {
        let (port, requests) = devtools_listing_run_page(run_page_url);
        let cancel_signal = JobCancelSignal::new();
        let run_id = Uuid::new_v4();
        let mut guard = SharedBrowserAgentControlGuard::acquire_with_path(
            directory.path().join("agent-control.json"),
            approval_dir.clone(),
            ApprovalStart::Routine,
            run_id,
            Uuid::new_v4(),
            "page-target",
            "Octo",
            cancel_signal.clone(),
            Duration::from_secs(60),
        )
        .expect("acquire run");
        guard.cdp_base = Some(("127.0.0.1".to_string(), port));
        write_run_record(
            &approval_dir,
            "tabs.json",
            &guard,
            json!({
                "currentTabId": current,
                "tabs": [
                    { "tabId": "TAB-A", "approvedOrigins": [] },
                    { "tabId": "TAB-B", "approvedOrigins": [] }
                ]
            }),
        );
        cancel_signal.confirm_shared_browser_shutdown();
        drop(guard);
        let seen = requests.lock().expect("requests").clone();
        (seen, run_id)
    };

    // Octo worked in tab B last: it stays, A closes, and B comes to the front.
    let (seen, first) = end_run("about:blank", json!("TAB-B"));
    assert_eq!(
        seen,
        strings(&[
            "GET /json/list HTTP/1.1",
            "GET /json/close/TAB-A HTTP/1.1",
            "GET /json/activate/TAB-B HTTP/1.1",
        ])
    );
    // The record names B as the page that run left its chat, and outlives the
    // run's own records.
    assert_eq!(
        chat_tabs(),
        json!({ "version": 1, "tabs": [{ "tabId": "TAB-B", "runId": first.to_string() }] })
    );
    assert!(!approval_dir.join("tabs.json").exists());
    #[cfg(unix)]
    assert_eq!(
        std::fs::metadata(approval_dir.join("chat-tabs.json"))
            .expect("chat tabs")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    // Back on the chat's own page at the end: the newest of its tabs stays,
    // and the record names it for this run, the latest one for that tab.
    let (seen, second) = end_run("chrome://newtab/", JsonValue::Null);
    assert_eq!(
        seen,
        strings(&[
            "GET /json/list HTTP/1.1",
            "GET /json/close/TAB-A HTTP/1.1",
            "GET /json/activate/TAB-B HTTP/1.1",
        ])
    );
    assert_eq!(
        chat_tabs(),
        json!({ "version": 1, "tabs": [{ "tabId": "TAB-B", "runId": second.to_string() }] })
    );
    // The chat's page shows a page of its own, and Octo went back to it at
    // the end: every tab of Octo's closes, and that page comes to the front,
    // never the neighbour Chromium would show. Nothing is added to the record.
    let (seen, _) = end_run(
        "https://www.visitlisboa.example/en/places/belem",
        JsonValue::Null,
    );
    assert_eq!(
        seen,
        strings(&[
            "GET /json/list HTTP/1.1",
            "GET /json/close/TAB-A HTTP/1.1",
            "GET /json/close/TAB-B HTTP/1.1",
            "GET /json/activate/page-target HTTP/1.1",
        ])
    );
    assert_eq!(
        chat_tabs(),
        json!({ "version": 1, "tabs": [{ "tabId": "TAB-B", "runId": second.to_string() }] })
    );
}

/// A browser turn that read the chat's own page, then went on in a tab of
/// its own and read there last (local test, Oct 30: Visit Porto's search in
/// the chat's tab, then Metro do Porto in Octo's tab 2). The page the person
/// is left with is the one Octo read last: that tab stays as the chat's page
/// and comes to the front, although the chat's own tab shows a page. Before,
/// it closed, and the chat went back to the older page.
#[tokio::test]
async fn a_run_that_read_last_in_its_own_tab_leaves_that_tab_as_the_chats_page() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    let (port, requests) =
        devtools_listing_run_page("https://www.visitporto.example/en-GB/search?q=lello");
    let cancel_signal = JobCancelSignal::new();
    let run_id = Uuid::new_v4();
    let mut guard = SharedBrowserAgentControlGuard::acquire_with_path(
        directory.path().join("agent-control.json"),
        approval_dir.clone(),
        ApprovalStart::Routine,
        run_id,
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire run");
    guard.cdp_base = Some(("127.0.0.1".to_string(), port));
    write_run_record(
        &approval_dir,
        "tabs.json",
        &guard,
        json!({
            "currentTabId": "TAB-A",
            "tabs": [
                { "tabId": "TAB-A", "approvedOrigins": [] },
                { "tabId": "TAB-B", "approvedOrigins": [] }
            ]
        }),
    );
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert_eq!(
        *requests.lock().expect("requests"),
        strings(&[
            "GET /json/list HTTP/1.1",
            "GET /json/close/TAB-B HTTP/1.1",
            "GET /json/activate/TAB-A HTTP/1.1",
        ])
    );
    let chat_tabs: JsonValue = serde_json::from_slice(
        &std::fs::read(approval_dir.join("chat-tabs.json")).expect("chat tabs"),
    )
    .expect("chat tabs JSON");
    assert_eq!(
        chat_tabs,
        json!({ "version": 1, "tabs": [{ "tabId": "TAB-A", "runId": run_id.to_string() }] })
    );
}

/// Ends a run on page `page-target` whose tab record names Octo's tabs A and
/// B (with the sites approved in each) and the tab it acts on at the end,
/// against a loopback DevTools endpoint that lists `list`. The requests that
/// endpoint answered, and the run.
fn end_run_listing(
    approval_dir: &Path,
    marker_path: &Path,
    list: JsonValue,
    current: JsonValue,
    tab_origins: [&[&str]; 2],
) -> (Vec<String>, Uuid) {
    let (port, requests) = devtools_listing(list);
    let cancel_signal = JobCancelSignal::new();
    let run_id = Uuid::new_v4();
    let mut guard = SharedBrowserAgentControlGuard::acquire_with_path(
        marker_path.to_path_buf(),
        approval_dir.to_path_buf(),
        ApprovalStart::Routine,
        run_id,
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire run");
    guard.cdp_base = Some(("127.0.0.1".to_string(), port));
    write_run_record(
        approval_dir,
        "tabs.json",
        &guard,
        json!({
            "currentTabId": current,
            "tabs": [
                { "tabId": "TAB-A", "approvedOrigins": tab_origins[0] },
                { "tabId": "TAB-B", "approvedOrigins": tab_origins[1] }
            ]
        }),
    );
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    let seen = requests.lock().expect("requests").clone();
    (seen, run_id)
}

/// A turn whose last step opened a tab of Octo's that never loaded (local
/// test, Oct 30: "Tried opening google.com") left that tab, blank or the
/// browser's error page, as the chat's page, and the page Octo had read in the
/// chat's own tab stopped being the chat's. A tab that shows no page is not
/// kept: Octo's tabs close, and the chat's own page comes to the front.
#[tokio::test]
async fn a_tab_of_octos_whose_page_never_loaded_is_not_left_as_the_chats_page() {
    for failed in ["chrome-error://chromewebdata/", "about:blank"] {
        let directory = tempfile::tempdir().expect("marker tempdir");
        let approval_dir = directory.path().join("approvals");
        let (seen, _) = end_run_listing(
            &approval_dir,
            &directory.path().join("agent-control.json"),
            json!([
                { "id": "TAB-B", "type": "page", "url": failed },
                { "id": "page-target", "type": "page", "url": "https://www.visitporto.example/en-GB/search?q=lello" },
                { "id": "TAB-A", "type": "page", "url": "https://metro.example/maps" }
            ]),
            json!("TAB-B"),
            [&[], &[]],
        );
        assert_eq!(
            seen,
            strings(&[
                "GET /json/list HTTP/1.1",
                "GET /json/close/TAB-A HTTP/1.1",
                "GET /json/close/TAB-B HTTP/1.1",
                "GET /json/activate/page-target HTTP/1.1",
            ]),
            "{failed}"
        );
        assert!(!approval_dir.join("chat-tabs.json").exists(), "{failed}");
    }
    // While the chat's own page is still blank, the newest of Octo's tabs
    // that shows a page stays instead.
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    let (seen, run_id) = end_run_listing(
        &approval_dir,
        &directory.path().join("agent-control.json"),
        json!([
            { "id": "TAB-B", "type": "page", "url": "chrome-error://chromewebdata/" },
            { "id": "page-target", "type": "page", "url": "about:blank" },
            { "id": "TAB-A", "type": "page", "url": "https://metro.example/maps" }
        ]),
        json!("TAB-B"),
        [&[], &[]],
    );
    assert_eq!(
        seen,
        strings(&[
            "GET /json/list HTTP/1.1",
            "GET /json/close/TAB-B HTTP/1.1",
            "GET /json/activate/TAB-A HTTP/1.1",
        ])
    );
    let chat_tabs: JsonValue = serde_json::from_slice(
        &std::fs::read(approval_dir.join("chat-tabs.json")).expect("chat tabs"),
    )
    .expect("chat tabs JSON");
    assert_eq!(
        chat_tabs,
        json!({ "version": 1, "tabs": [{ "tabId": "TAB-A", "runId": run_id.to_string() }] })
    );
}

/// A follow-up goes on in the tab the turn left the chat (Studio's
/// `leftByRun`, naming the run it continues). The run's approvals were tied
/// to the run's own page, so the follow-up in the kept tab lost them: it
/// asked again for every site, and off an attested host lost routine
/// browsing too. It now carries routine browsing and the sites approved in
/// that tab, never those approved on the chat's earlier page.
#[tokio::test]
async fn a_follow_up_in_the_tab_a_turn_left_its_chat_keeps_that_tabs_approvals() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    let marker_path = directory.path().join("agent-control.json");
    let person = Uuid::new_v4();
    let (port, _) =
        devtools_listing_run_page("https://www.visitporto.example/en-GB/search?q=lello");
    let acquire = |run_id: Uuid, page: &str, continues: Option<Uuid>| {
        let cancel_signal = JobCancelSignal::new();
        let mut guard = SharedBrowserAgentControlGuard::acquire_continuing(
            marker_path.clone(),
            approval_dir.clone(),
            ApprovalStart::Ask,
            run_id,
            person,
            page,
            "Octo",
            continues,
            &[],
            cancel_signal.clone(),
            Duration::from_secs(60),
        )
        .expect("acquire run");
        guard.cdp_base = Some(("127.0.0.1".to_string(), port));
        (guard, cancel_signal)
    };
    let end = |(guard, cancel_signal): (SharedBrowserAgentControlGuard, JobCancelSignal)| {
        cancel_signal.confirm_shared_browser_shutdown();
        drop(guard);
    };
    let state = || -> Option<JsonValue> {
        std::fs::read(approval_dir.join("state.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).expect("state JSON"))
    };

    // The turn: a site approved on the chat's page, routine browsing allowed,
    // and the metro site approved in Octo's tab A, where it read last.
    let first = Uuid::new_v4();
    let run = acquire(first, "page-target", None);
    write_run_state(
        &marker_path,
        &approval_dir,
        &["https://www.visitporto.example"],
        true,
    );
    write_run_record(
        &approval_dir,
        "tabs.json",
        &run.0,
        json!({
            "currentTabId": "TAB-A",
            "tabs": [
                { "tabId": "TAB-A", "approvedOrigins": ["https://metro.example"] },
                { "tabId": "TAB-B", "approvedOrigins": [] }
            ]
        }),
    );
    end(run);

    // The follow-up, in tab A.
    let run = acquire(Uuid::new_v4(), "TAB-A", Some(first));
    let carried = state().expect("carried state");
    assert_eq!(carried["approvedOrigins"], json!(["https://metro.example"]));
    assert_eq!(carried["routineBrowsingAllowed"], true);
    assert_eq!(carried["browserPageId"], "TAB-A");
    end(run);

    // Only in that tab: a run in another tab of the turn carries nothing.
    let second = Uuid::new_v4();
    let run = acquire(second, "page-target", None);
    write_run_state(
        &marker_path,
        &approval_dir,
        &["https://www.visitporto.example"],
        true,
    );
    write_run_record(
        &approval_dir,
        "tabs.json",
        &run.0,
        json!({
            "currentTabId": "TAB-A",
            "tabs": [
                { "tabId": "TAB-A", "approvedOrigins": ["https://metro.example"] },
                { "tabId": "TAB-B", "approvedOrigins": [] }
            ]
        }),
    );
    end(run);
    let run = acquire(Uuid::new_v4(), "TAB-B", Some(second));
    assert!(state().is_none());
    end(run);
}

/// Each turn that ends in a tab of Octo's keeps it as the chat's page, one
/// more tab of the person's. As when Studio opens a tab for a chat, past 24
/// tabs the one used least recently closes: never the kept tab, the chat's
/// earlier page, the tab used last, or one of Octo's.
#[tokio::test]
async fn a_tab_kept_as_the_chats_page_makes_room_past_twenty_four_tabs() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    let page = |id: &str, url: &str| json!({ "id": id, "type": "page", "url": url });
    let mut list = vec![
        page("TAB-A", "https://metro.example/maps"),
        page(
            "page-target",
            "https://www.visitporto.example/en-GB/search?q=lello",
        ),
        page("TAB-B", "https://trams.example/planner"),
    ];
    for index in 1..=23 {
        list.push(page(
            &format!("OLD-{index}"),
            &format!("https://site-{index}.example/"),
        ));
    }
    let (seen, _) = end_run_listing(
        &approval_dir,
        &directory.path().join("agent-control.json"),
        JsonValue::Array(list.clone()),
        json!("TAB-A"),
        [&[], &[]],
    );
    // 25 tabs once B closes: the one used least recently makes room.
    assert_eq!(
        seen,
        strings(&[
            "GET /json/list HTTP/1.1",
            "GET /json/close/TAB-B HTTP/1.1",
            "GET /json/activate/TAB-A HTTP/1.1",
            "GET /json/close/OLD-23 HTTP/1.1",
        ])
    );
    // At 24 tabs, none closes.
    list.pop();
    let directory = tempfile::tempdir().expect("marker tempdir");
    let (seen, _) = end_run_listing(
        &directory.path().join("approvals"),
        &directory.path().join("agent-control.json"),
        JsonValue::Array(list),
        json!("TAB-A"),
        [&[], &[]],
    );
    assert_eq!(
        seen,
        strings(&[
            "GET /json/list HTTP/1.1",
            "GET /json/close/TAB-B HTTP/1.1",
            "GET /json/activate/TAB-A HTTP/1.1",
        ])
    );
}

/// The record of the pages earlier runs left their chats (`chat-tabs.json`)
/// outlives the runs, so a later run's controller works beside it.
#[test]
fn a_run_works_beside_the_record_of_pages_earlier_runs_left_their_chats() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    record_tab_left_for_chat(&fixture.approval_dir, "TAB-EARLIER", Uuid::new_v4()).expect("record");
    payload_of(&fixture.call("safe", "GET", "/v1/snapshot", None));
}

/// The chat tab record is bounded, newest last, and one that cannot be read
/// safely names no tab.
#[test]
fn the_chat_tab_record_keeps_the_newest_tabs() {
    let directory = tempfile::tempdir().expect("approval tempdir");
    let approval_dir = directory.path().join("approvals");
    prepare_clean_approval_directory(&approval_dir).expect("approval directory");
    let runs: Vec<Uuid> = (0..MAX_CHAT_TABS + 2).map(|_| Uuid::new_v4()).collect();
    for (index, run_id) in runs.iter().enumerate() {
        record_tab_left_for_chat(&approval_dir, &format!("TAB-{index}"), *run_id).expect("record");
    }
    let entries = read_chat_tabs(&approval_dir);
    assert_eq!(entries.len(), MAX_CHAT_TABS);
    assert_eq!(entries.first(), Some(&("TAB-2".to_string(), runs[2])));
    assert_eq!(
        entries.last(),
        Some(&(
            format!("TAB-{}", MAX_CHAT_TABS + 1),
            runs[MAX_CHAT_TABS + 1]
        ))
    );
    std::fs::write(
        approval_dir.join("chat-tabs.json"),
        br#"{"version":1,"tabs":[{"tabId":"TAB-1","runId":"not-a-run"}]}"#,
    )
    .expect("write");
    assert!(read_chat_tabs(&approval_dir).is_empty());
    assert!(record_tab_left_for_chat(&approval_dir, "../TAB", runs[0]).is_err());
}

// Hardening of Octo's tabs: the link-only guard in every tab Octo drives,
// Octo's tab or the run's page in front whenever Octo closes something, one
// number per tab for its lifetime, no window Octo's tabs open by themselves,
// and no tab of Octo's left unbadged or open after a run that did not end
// cleanly.

impl EmbeddedControllerFixture {
    fn front(&self) -> String {
        std::fs::read_to_string(&self.front_tab).expect("front tab")
    }

    fn tab_id_of(&self, opened: &JsonValue) -> String {
        opened["tabId"].as_str().expect("tab id").to_string()
    }

    fn cdp_calls(&self, method: &str) -> Vec<JsonValue> {
        std::fs::read_to_string(&self.cdp_log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<JsonValue>(line).expect("cdp call"))
            .filter(|call| call["method"] == method)
            .collect()
    }
}

#[test]
fn closing_octos_tabs_never_leaves_a_persons_tab_in_front() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let first = fixture.tab_id_of(&fixture.open_tab("https://example.test/one"));
    let second = fixture.tab_id_of(&fixture.open_tab("https://example.test/two"));
    assert_eq!(fixture.front(), second);

    // Octo closes the tab it works in. Chromium shows a neighbouring tab,
    // which may be the person's; the run's page comes to the front instead.
    payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/close",
        Some(&json!({ "tabId": second }).to_string()),
    ));
    assert_eq!(fixture.front(), "page-target");

    // Octo closes its last tab.
    payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/select",
        Some(&json!({ "tabId": first }).to_string()),
    ));
    assert_eq!(fixture.front(), first);
    let closed = payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/close",
        Some(&json!({ "tabId": first }).to_string()),
    ));
    assert_eq!(fixture.front(), "page-target");
    assert_eq!(closed["agentTabsOpen"], 0);
    assert_eq!(closed["tabs"][0]["tabId"], "page-target");
    assert_eq!(closed["tabs"][0]["current"], true);
    assert!(fixture.browser_tabs().is_empty());

    // A new tab the person denies goes again, and the tab Octo was in comes
    // back to the front.
    fixture.prepare_authority("page-target", &[]);
    let (output, _requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/tabs/open",
        Some(r#"{"url":"https://example.test/three"}"#),
        &["deny"],
    );
    assert!(failure_of(&output).contains("[site_declined]"));
    assert!(fixture.browser_tabs().is_empty());
    assert_eq!(fixture.front(), "page-target");
}

#[test]
fn each_of_octos_tabs_keeps_one_label_in_prompts_and_list_tabs_while_it_is_open() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority("page-target", &[]);
    let mut tab_ids = Vec::new();
    for number in 1..=3 {
        let (output, requests) = fixture.call_deciding(
            "safe",
            "POST",
            "/v1/tabs/open",
            Some(&json!({ "url": format!("https://example.test/report-{number}") }).to_string()),
            &["allow_origin", "allow_once"],
        );
        let opened = payload_of(&output);
        assert_eq!(opened["tabLabel"], format!("Octo's tab {number}"));
        assert_eq!(
            requests[0]["display"]["label"],
            format!("Octo's tab {number}: Open https://example.test/report-{number} in a new tab")
        );
        tab_ids.push(fixture.tab_id_of(&opened));
    }

    // Closing tab 1 renumbers nothing: tab 3 is still "Octo's tab 3" in its
    // prompts, as it is in list_tabs and in Studio.
    payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/close",
        Some(&json!({ "tabId": tab_ids[0] }).to_string()),
    ));
    payload_of(&fixture.call(
        "safe",
        "POST",
        "/v1/tabs/select",
        Some(&json!({ "tabId": tab_ids[2] }).to_string()),
    ));
    let (output, requests) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://other.example/pricing"}"#),
        &["allow_origin", "allow_once"],
    );
    assert_eq!(payload_of(&output)["tabLabel"], "Octo's tab 3");
    assert_eq!(
        requests
            .iter()
            .map(|request| request["display"]["label"]
                .as_str()
                .expect("label")
                .to_string())
            .collect::<Vec<_>>(),
        vec!["Octo's tab 3: Open https://other.example/pricing".to_string()]
    );
    let listed = payload_of(&fixture.call("safe", "GET", "/v1/tabs", None));
    let labels = listed["tabs"]
        .as_array()
        .expect("tabs")
        .iter()
        .map(|tab| {
            (
                tab["tabId"].as_str().map(str::to_string),
                tab.get("label").cloned(),
                tab.get("number").cloned(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        labels,
        vec![
            (Some("page-target".to_string()), None, None),
            (
                Some(tab_ids[1].clone()),
                Some(json!("Octo's tab 2")),
                Some(json!(2))
            ),
            (
                Some(tab_ids[2].clone()),
                Some(json!("Octo's tab 3")),
                Some(json!(3))
            ),
        ]
    );

    // A new tab takes the next number; a number is never given twice in a run.
    let (output, _) = fixture.call_deciding(
        "safe",
        "POST",
        "/v1/tabs/open",
        Some(r#"{"url":"https://example.test/report-4"}"#),
        &["allow_origin", "allow_once"],
    );
    assert_eq!(payload_of(&output)["tabLabel"], "Octo's tab 4");
    let record = fixture.tab_record();
    assert_eq!(record["version"], 2);
    assert_eq!(record["lastTabNumber"], 4);
    assert_eq!(
        record["tabs"]
            .as_array()
            .expect("tabs")
            .iter()
            .map(|tab| tab["number"].clone())
            .collect::<Vec<_>>(),
        vec![json!(2), json!(3), json!(4)]
    );
}

#[test]
fn octo_never_opens_or_reads_a_link_only_site_on_the_page_the_person_chose() {
    let fixture = EmbeddedControllerFixture::new();
    let decisions = ["allow_origin", "allow_once", "allow_once"];
    for url in [
        "https://www.booking.com/hotel/fixture.html",
        "https://www.airbnb.co.uk/rooms/1",
        "https://amazon.de/dp/1",
    ] {
        let (output, requests) = fixture.run_with_decisions(
            "safe",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(&json!({ "url": url }).to_string()),
            &["https://example.test"],
            &decisions,
        );
        let error = failure_of(&output);
        assert!(
            error.contains("is link-only: Octo never opens it, in any tab"),
            "{url}: {error}"
        );
        assert!(error.contains("Send page to Octo"), "{url}: {error}");
        assert!(requests.is_empty(), "{url} asked: {requests:?}");
    }

    // A link to a link-only site is refused before any prompt: on a site
    // the person approved, and on one not approved yet, before its prompt.
    let snapshot_id = fixture.snapshot_id("link-only-link");
    for approved in [&["https://example.test"][..], &[]] {
        let (output, requests) = fixture.run_with_decisions(
            "link-only-link",
            "page-target",
            "POST",
            "/v1/click",
            Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
            approved,
            &decisions,
        );
        let error = failure_of(&output);
        assert!(
            error.contains("Booking.com is link-only"),
            "{approved:?}: {error}"
        );
        assert!(requests.is_empty(), "{approved:?} asked: {requests:?}");
    }
    assert!(!fixture.click_log.exists(), "the link was never clicked");

    // The page the person chose is on a link-only site: Octo reads and does
    // nothing there, before any prompt, and says how the person can share it.
    for (method, path, body) in [
        ("GET", "/v1/snapshot", None),
        ("GET", "/v1/status", None),
        ("POST", "/v1/scroll", Some(r#"{"x":0,"y":720}"#)),
        (
            "POST",
            "/v1/click",
            Some(
                r#"{"index":0,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#,
            ),
        ),
    ] {
        for approved in [&[][..], &["https://www.booking.com"][..]] {
            let (output, requests) = fixture.run_with_decisions(
                "link-only-page",
                "page-target",
                method,
                path,
                body,
                approved,
                &decisions,
            );
            let error = failure_of(&output);
            assert!(
                error.contains("The page the person chose is now on Booking.com, which is link-only, so nothing there was read or done"),
                "{path}: {error}"
            );
            assert!(error.contains("Send page to Octo"), "{path}: {error}");
            assert!(requests.is_empty(), "{path} asked: {requests:?}");
        }
    }
    let listed = payload_of(&fixture.run("link-only-page", "GET", "/v1/tabs", None));
    assert_eq!(listed["tabs"][0]["linkOnlySite"], "Booking.com");
    assert_eq!(listed["tabs"][0]["url"], JsonValue::Null);
    assert_eq!(listed["tabs"][0]["title"], JsonValue::Null);
    assert_no_canary("link-only list_tabs", &listed.to_string());
    assert!(
        !fixture.action_log().contains("booking"),
        "{}",
        fixture.action_log()
    );
}

#[test]
fn without_the_link_only_list_octo_opens_and_reads_nothing_in_any_tab() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    for (method, path, body) in [
        ("GET", "/v1/snapshot", None),
        ("GET", "/v1/status", None),
        ("POST", "/v1/scroll", Some(r#"{"x":0,"y":720}"#)),
        (
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://example.test/report"}"#),
        ),
        (
            "POST",
            "/v1/tabs/open",
            Some(r#"{"url":"https://example.test/report"}"#),
        ),
    ] {
        let output = fixture
            .command_for("safe", "page-target", method, path, body)
            .without_link_only_list()
            .output()
            .expect("run without the list");
        let error = failure_of(&output);
        assert!(
            error.contains("The link-only site list is unavailable"),
            "{path}: {error}"
        );
    }
    assert!(fixture.browser_tabs().is_empty());
    // The same calls run with the list.
    payload_of(&fixture.call("safe", "GET", "/v1/snapshot", None));
}

#[test]
fn a_window_a_page_in_octos_tab_opened_by_itself_is_closed_before_the_next_step() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let tab_id = fixture.tab_id_of(&fixture.open_tab("https://example.test/report"));
    // Between steps the page in Octo's tab opened a window, which opened
    // another; the person's page and another tab opened one each.
    std::fs::write(
        &fixture.open_windows,
        json!([
            { "targetId": "WINDOW-1", "type": "page", "openerId": tab_id },
            { "targetId": "WINDOW-2", "type": "page", "openerId": "WINDOW-1" },
            { "targetId": "PERSONS-WINDOW", "type": "page", "openerId": "page-target" },
            { "targetId": "OTHER-TAB", "type": "page" },
            { "targetId": "WORKER", "type": "service_worker", "openerId": tab_id },
        ])
        .to_string(),
    )
    .expect("open windows");

    let listed = payload_of(&fixture.call("safe", "GET", "/v1/tabs", None));
    let closed = fixture
        .cdp_calls("Target.closeTarget")
        .iter()
        .map(|call| {
            call["params"]["targetId"]
                .as_str()
                .expect("target")
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(closed, vec!["WINDOW-1".to_string(), "WINDOW-2".to_string()]);
    let left = serde_json::from_slice::<Vec<JsonValue>>(
        &std::fs::read(&fixture.open_windows).expect("windows"),
    )
    .expect("windows JSON")
    .iter()
    .map(|info| info["targetId"].as_str().expect("target").to_string())
    .collect::<Vec<_>>();
    assert_eq!(left, vec!["PERSONS-WINDOW", "OTHER-TAB", "WORKER"]);
    assert_eq!(
        listed["tabs"]
            .as_array()
            .expect("tabs")
            .iter()
            .map(|tab| tab["tabId"].as_str().expect("tab id").to_string())
            .collect::<Vec<_>>(),
        vec!["page-target".to_string(), tab_id.clone()]
    );
    // The windows came to the front when they opened; Octo's tab is back.
    std::fs::write(&fixture.front_tab, "WINDOW-3").expect("a window in front");
    std::fs::write(
        &fixture.open_windows,
        json!([{ "targetId": "WINDOW-3", "type": "page", "openerId": tab_id }]).to_string(),
    )
    .expect("another window");
    payload_of(&fixture.call("safe", "GET", "/v1/tabs", None));
    assert_eq!(fixture.front(), tab_id);
}

/// A loopback stand-in for Chromium's DevTools endpoint that speaks the
/// target-discovery protocol: it answers `/json/version`, sends `events` once
/// discovery is on, and records the targets it is asked to close.
async fn fake_target_discovery(
    events: Vec<JsonValue>,
) -> (std::net::SocketAddr, Arc<std::sync::Mutex<Vec<String>>>) {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::AsyncWriteExt as _;
    use tokio_tungstenite::tungstenite::Message;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("fake devtools");
    let address = listener.local_addr().expect("fake devtools address");
    let closed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = Arc::clone(&closed);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let mut head = [0u8; 32];
            let read = stream.peek(&mut head).await.unwrap_or(0);
            if head[..read].starts_with(b"GET /json/version") {
                let body = json!({
                    "Browser": "Chrome/fixture",
                    "webSocketDebuggerUrl": format!("ws://{address}/devtools/browser/fixture-browser-1"),
                })
                .to_string();
                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
                continue;
            }
            let events = events.clone();
            let recorded = Arc::clone(&recorded);
            tokio::spawn(async move {
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                while let Some(Ok(message)) = socket.next().await {
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let command: JsonValue = serde_json::from_str(&text).expect("command");
                    match command["method"].as_str() {
                        Some("Target.setDiscoverTargets") => {
                            let _ = socket
                                .send(Message::Text(
                                    json!({ "id": command["id"], "result": {} }).to_string(),
                                ))
                                .await;
                            for event in &events {
                                let _ = socket.send(Message::Text(event.to_string())).await;
                            }
                        }
                        Some(method @ ("Target.closeTarget" | "Target.activateTarget")) => {
                            let target = command["params"]["targetId"].as_str().expect("target");
                            recorded.lock().expect("closed").push(
                                if method == "Target.closeTarget" {
                                    target.to_string()
                                } else {
                                    format!("front:{target}")
                                },
                            );
                            let _ = socket
                                .send(Message::Text(
                                    json!({ "id": command["id"], "result": { "success": true } })
                                        .to_string(),
                                ))
                                .await;
                        }
                        _ => {}
                    }
                }
            });
        }
    });
    (address, closed)
}

fn target_created(target_id: &str, kind: &str, opener_id: Option<&str>) -> JsonValue {
    let mut info = json!({ "targetId": target_id, "type": kind, "url": "https://example.test/" });
    if let Some(opener_id) = opener_id {
        info["openerId"] = json!(opener_id);
    }
    json!({ "method": "Target.targetCreated", "params": { "targetInfo": info } })
}

#[tokio::test]
async fn while_a_run_holds_the_browser_windows_its_tabs_open_by_themselves_close_as_they_appear() {
    let (address, closed) = fake_target_discovery(vec![
        target_created("page-target", "page", None),
        target_created("TAB-A", "page", None),
        target_created("PERSONS-TAB", "page", None),
        target_created("WINDOW-1", "page", Some("TAB-A")),
        target_created("WINDOW-2", "page", Some("WINDOW-1")),
        target_created("PERSONS-WINDOW", "page", Some("page-target")),
        target_created("OTHER-WINDOW", "page", Some("PERSONS-TAB")),
        target_created("WORKER", "service_worker", Some("TAB-A")),
        target_created("TAB-A", "page", Some("WINDOW-1")),
    ])
    .await;
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    let cancel_signal = JobCancelSignal::new();
    let mut guard = SharedBrowserAgentControlGuard::acquire_with_path(
        directory.path().join("agent-control.json"),
        approval_dir.clone(),
        ApprovalStart::Routine,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire run");
    write_run_record(
        &approval_dir,
        "tabs.json",
        &guard,
        json!({
            "version": 2,
            "currentTabId": "TAB-A",
            "lastTabNumber": 1,
            "tabs": [{ "tabId": "TAB-A", "number": 1, "approvedOrigins": [] }]
        }),
    );
    guard.cdp_base = Some(("127.0.0.1".to_string(), address.port()));
    guard.start_window_watch();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while closed.lock().expect("closed").len() < 4 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Give a wrong close a moment to arrive before checking there is none.
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Each window closes, and the tab Octo acts on comes back to the front.
    assert_eq!(
        *closed.lock().expect("closed"),
        vec![
            "WINDOW-1".to_string(),
            "front:TAB-A".to_string(),
            "WINDOW-2".to_string(),
            "front:TAB-A".to_string(),
        ]
    );
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
}

/// A loopback port nothing listens on: a browser that is down.
fn unreachable_devtools() -> (String, u16) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("address").port();
    drop(listener);
    ("127.0.0.1".to_string(), port)
}

fn leftover_record(approval_dir: &Path) -> Option<JsonValue> {
    std::fs::read(approval_dir.join(LEFTOVER_AGENT_TABS_FILE))
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).expect("leftover JSON"))
}

#[test]
fn octos_tabs_left_open_by_a_run_that_did_not_end_cleanly_stay_badged_and_close_at_the_next_start()
{
    let (address, requests) = fake_devtools();
    let directory = tempfile::tempdir().expect("startup tempdir");
    let marker_path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    std::fs::create_dir_all(&approval_dir).expect("approvals");
    let (owner_id, run_id, initiator_user_id) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let bound = |extra: JsonValue| {
        let mut record = json!({
            "ownerId": owner_id.to_string(),
            "runId": run_id,
            "initiatorUserId": initiator_user_id,
            "browserPageId": "page-target",
        });
        for (key, value) in extra.as_object().expect("extra") {
            record[key] = value.clone();
        }
        record
    };
    let write = |path: &Path, record: JsonValue| {
        std::fs::write(path, record.to_string()).expect("write record");
        #[cfg(unix)]
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).expect("protect");
    };
    let leave_unconfirmed_run = || {
        write(
            &marker_path,
            bound(json!({ "version": 2, "displayName": "Octo", "expiresAtMs": 1 })),
        );
        write(
            &approval_dir.join("tabs.json"),
            bound(json!({
                "version": 2,
                "currentTabId": "TAB-C",
                "lastTabNumber": 3,
                "tabs": [
                    { "tabId": "TAB-A", "number": 1, "approvedOrigins": [] },
                    { "tabId": "TAB-B", "number": 2, "approvedOrigins": [] },
                    { "tabId": "TAB-C", "number": 3, "approvedOrigins": [] }
                ]
            })),
        );
        write(
            &approval_dir.join("kept-tabs.json"),
            bound(json!({ "version": 1, "tabIds": ["TAB-B"] })),
        );
    };

    // The process ended while a run held the browser. At the next start the
    // browser does not answer yet: the run's records are revoked, but its
    // unkept tabs stay recorded, so they stay badged.
    leave_unconfirmed_run();
    clear_stale_agent_control_marker_at_startup(
        true,
        &marker_path,
        &approval_dir,
        Some(&unreachable_devtools()),
    )
    .expect("startup");
    assert!(!marker_path.exists());
    assert!(!approval_dir.join("tabs.json").exists());
    assert!(!approval_dir.join("kept-tabs.json").exists());
    assert_eq!(
        leftover_record(&approval_dir),
        Some(json!({
            "version": 1,
            "tabs": [{ "tabId": "TAB-A" }, { "tabId": "TAB-C" }]
        }))
    );
    #[cfg(unix)]
    assert_eq!(
        std::fs::metadata(approval_dir.join(LEFTOVER_AGENT_TABS_FILE))
            .expect("leftover")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    // At the start after that the browser answers: they close, and nothing
    // is left to badge.
    clear_stale_agent_control_marker_at_startup(
        true,
        &marker_path,
        &approval_dir,
        Some(&("127.0.0.1".to_string(), address.port())),
    )
    .expect("startup");
    assert_eq!(
        *requests.lock().expect("requests"),
        vec![
            "GET /json/close/TAB-A HTTP/1.1".to_string(),
            "GET /json/close/TAB-C HTTP/1.1".to_string(),
        ]
    );
    assert_eq!(leftover_record(&approval_dir), None);

    // A start that finds the browser up closes them at once.
    requests.lock().expect("requests").clear();
    leave_unconfirmed_run();
    clear_stale_agent_control_marker_at_startup(
        true,
        &marker_path,
        &approval_dir,
        Some(&("127.0.0.1".to_string(), address.port())),
    )
    .expect("startup");
    assert_eq!(requests.lock().expect("requests").len(), 2);
    assert_eq!(leftover_record(&approval_dir), None);

    // A record bound to another run than the marker names no tab.
    requests.lock().expect("requests").clear();
    leave_unconfirmed_run();
    let mut other = serde_json::from_slice::<JsonValue>(
        &std::fs::read(approval_dir.join("tabs.json")).expect("tabs"),
    )
    .expect("tabs JSON");
    other["runId"] = json!(Uuid::new_v4());
    write(&approval_dir.join("tabs.json"), other);
    clear_stale_agent_control_marker_at_startup(
        true,
        &marker_path,
        &approval_dir,
        Some(&("127.0.0.1".to_string(), address.port())),
    )
    .expect("startup");
    assert!(requests.lock().expect("requests").is_empty());
    assert_eq!(leftover_record(&approval_dir), None);
}

#[tokio::test]
async fn the_next_confirmed_end_closes_leftover_tabs_and_keeps_those_it_cannot_close() {
    let (address, requests) = fake_devtools();
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    std::fs::create_dir_all(&approval_dir).expect("approvals");
    write_leftover_agent_tabs(&approval_dir, &["EARLIER-TAB".to_string()]).expect("leftover");
    let acquire = || {
        let cancel_signal = JobCancelSignal::new();
        let guard = SharedBrowserAgentControlGuard::acquire_with_path(
            directory.path().join("agent-control.json"),
            approval_dir.clone(),
            ApprovalStart::Routine,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "page-target",
            "Octo",
            cancel_signal.clone(),
            Duration::from_secs(60),
        )
        .expect("acquire run");
        (guard, cancel_signal)
    };

    // A new run starts: its records start empty, the leftover record stays.
    let (mut guard, cancel_signal) = acquire();
    assert!(leftover_record(&approval_dir).is_some());
    write_run_record(
        &approval_dir,
        "tabs.json",
        &guard,
        json!({
            "version": 2,
            "currentTabId": null,
            "lastTabNumber": 1,
            "tabs": [{ "tabId": "TAB-A", "number": 1, "approvedOrigins": [] }]
        }),
    );
    // Its end is confirmed but the browser does not answer: its tab joins
    // the leftovers instead of becoming an unbadged ordinary tab.
    guard.cdp_base = Some(unreachable_devtools());
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert_eq!(
        leftover_record(&approval_dir),
        Some(json!({
            "version": 1,
            "tabs": [{ "tabId": "EARLIER-TAB" }, { "tabId": "TAB-A" }]
        }))
    );
    assert!(!approval_dir.join("tabs.json").exists());

    // The next run's confirmed end closes them all.
    let (mut guard, cancel_signal) = acquire();
    guard.cdp_base = Some(("127.0.0.1".to_string(), address.port()));
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert_eq!(
        *requests.lock().expect("requests"),
        vec![
            "GET /json/close/EARLIER-TAB HTTP/1.1".to_string(),
            "GET /json/close/TAB-A HTTP/1.1".to_string(),
        ]
    );
    assert_eq!(leftover_record(&approval_dir), None);
}

/// A browser whose DevTools endpoint answers `/json/close/<id>` with the
/// status `answer` gives for that id, after running it.
fn scripted_devtools(answer: impl Fn(&str) -> &'static str + Send + 'static) -> u16 {
    use std::io::{BufRead, BufReader};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("scripted devtools");
    let port = listener
        .local_addr()
        .expect("scripted devtools address")
        .port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().expect("stream"));
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let tab_id = line
                .split_whitespace()
                .nth(1)
                .and_then(|path| path.strip_prefix("/json/close/"))
                .unwrap_or_default()
                .to_string();
            let status = answer(&tab_id);
            let _ = stream
                .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes());
        }
    });
    port
}

#[tokio::test]
async fn a_leftover_tab_a_person_keeps_while_the_run_ends_stays_theirs() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let approval_dir = directory.path().join("approvals");
    std::fs::create_dir_all(&approval_dir).expect("approvals");
    write_leftover_agent_tabs(
        &approval_dir,
        &["EARLIER-A".to_string(), "EARLIER-B".to_string()],
    )
    .expect("leftover");
    let cancel_signal = JobCancelSignal::new();
    let mut guard = SharedBrowserAgentControlGuard::acquire_with_path(
        directory.path().join("agent-control.json"),
        approval_dir.clone(),
        ApprovalStart::Routine,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire run");
    write_run_record(
        &approval_dir,
        "tabs.json",
        &guard,
        json!({
            "version": 2,
            "currentTabId": null,
            "lastTabNumber": 1,
            "tabs": [{ "tabId": "TAB-A", "number": 1, "approvedOrigins": [] }]
        }),
    );
    // While the run's end closes the tabs, a person keeps EARLIER-B: the
    // origin takes it off the leftover record. The browser then does not
    // close EARLIER-B, nor the run's TAB-A.
    let record = approval_dir.join(LEFTOVER_AGENT_TABS_FILE);
    let port = scripted_devtools(move |tab_id| {
        if tab_id != "EARLIER-A" {
            return "500 Internal Server Error";
        }
        std::fs::write(
            &record,
            json!({ "version": 1, "tabs": [{ "tabId": "EARLIER-A" }] }).to_string(),
        )
        .expect("keep EARLIER-B");
        "200 OK"
    });
    guard.cdp_base = Some(("127.0.0.1".to_string(), port));
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    // The kept tab stays an ordinary tab; the run's tab that is still open
    // joins the record.
    assert_eq!(
        leftover_record(&approval_dir),
        Some(json!({ "version": 1, "tabs": [{ "tabId": "TAB-A" }] }))
    );
}

impl EmbeddedControllerFixture {
    fn fetch_answers(&self) -> Vec<(String, String)> {
        std::fs::read_to_string(&self.fetch_log)
            .unwrap_or_default()
            .lines()
            .map(|line| {
                let answer: JsonValue = serde_json::from_str(line).expect("fetch answer");
                (
                    answer["method"].as_str().expect("method").to_string(),
                    answer["requestId"].as_str().expect("request").to_string(),
                )
            })
            .collect()
    }

    fn snapshot_id_in(&self, mode: &str) -> String {
        payload_of(&self.call(mode, "GET", "/v1/snapshot", None))["snapshotId"]
            .as_str()
            .expect("snapshot id")
            .to_string()
    }
}

#[test]
fn octo_reads_nothing_of_a_page_that_reached_a_link_only_site_while_or_before_it_was_read() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");

    // A timed redirect to a link-only site commits while the snapshot reads
    // the page the person chose: nothing of it is reported, not under the
    // earlier page's address either.
    let output = fixture.call("moves-to-link-only-while-read", "GET", "/v1/snapshot", None);
    let raced = failure_of(&output);
    assert!(
        raced.contains("The page the person chose is now on Booking.com, which is link-only, so nothing there was read"),
        "{raced}"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Link-only hotel page"));

    // A step's tab reaches a link-only site by a load the step's document
    // guard did not see: the page after the step is not read, and the feed
    // does not carry its address or title.
    let snapshot_id = fixture.snapshot_id_in("link-only-after-click");
    let output = fixture.call(
        "link-only-after-click",
        "POST",
        "/v1/click",
        Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
    );
    let stepped = failure_of(&output);
    assert!(
        stepped.contains("is now on Booking.com, which is link-only, so nothing there was read"),
        "{stepped}"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Link-only hotel page"));
    let feed = fixture.action_log();
    assert!(!feed.contains("booking.com"), "{feed}");
    assert!(
        feed.contains("Page changed to Booking.com, which is link-only"),
        "{feed}"
    );

    // The same in one of Octo's tabs.
    fixture.open_tab("https://example.test/report");
    let snapshot_id = fixture.snapshot_id_in("link-only-after-click");
    let output = fixture.call(
        "link-only-after-click",
        "POST",
        "/v1/click",
        Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
    );
    let in_tab = failure_of(&output);
    assert!(
        in_tab.contains(
            "Octo's tab 1 is now on Booking.com, which is link-only, so nothing there was read"
        ),
        "{in_tab}"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Link-only hotel page"));
}

#[test]
fn a_frame_from_a_link_only_site_inside_an_ordinary_page_does_not_fail_octos_step() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let click = |mode: &str| {
        let snapshot_id = fixture.snapshot_id_in(mode);
        fixture.call(
            mode,
            "POST",
            "/v1/click",
            Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
        )
    };

    // A step loads an ordinary page that frames a map from a link-only site,
    // on the page the person chose and in one of Octo's tabs: the frame is
    // not the tab going there, so it loads and the step succeeds.
    for in_tab in [false, true] {
        if in_tab {
            fixture.open_tab("https://example.test/hotel");
        }
        std::fs::remove_file(&fixture.fetch_log).ok();
        let clicked = payload_of(&click("loads-link-only-frame"));
        assert_eq!(clicked["visibleText"], "Fixture page", "in a tab: {in_tab}");
        assert_eq!(
            fixture.fetch_answers(),
            vec![(
                "Fetch.continueRequest".to_string(),
                "request-child-frame".to_string()
            )],
            "in a tab: {in_tab}"
        );
    }

    // The tab's own document is still stopped before it reaches one.
    std::fs::remove_file(&fixture.fetch_log).ok();
    let refused = failure_of(&click("redirects-to-link-only"));
    assert!(
        refused.contains("led to Booking.com, which is link-only, so it was not opened"),
        "{refused}"
    );
    assert_eq!(
        fixture.fetch_answers(),
        vec![("Fetch.failRequest".to_string(), "request-main".to_string())]
    );
}

#[test]
fn a_link_only_site_is_refused_however_its_address_writes_the_host() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    for url in [
        "https://WWW.BOOKING.COM./hotel",
        "https://www.booking.com../hotel",
        "https://www.booking.com...:443/hotel",
        "https://booking%2ecom/hotel",
        "https://\u{ff42}\u{ff4f}\u{ff4f}\u{ff4b}\u{ff49}\u{ff4e}\u{ff47}.com/hotel",
        "https://booking\u{3002}com/hotel",
        "http://m.booking.com:8080/hotel",
    ] {
        for (path, body) in [
            ("/v1/navigate", json!({ "url": url })),
            ("/v1/tabs/open", json!({ "url": url })),
        ] {
            let error = failure_of(&fixture.call("safe", "POST", path, Some(&body.to_string())));
            assert!(
                error.contains("Booking.com is link-only: Octo never opens it, in any tab"),
                "{path} {url}: {error}"
            );
        }
    }
    assert!(fixture.browser_tabs().is_empty());
}

// The link-only list on every route Octo uses: the readers' shared table of
// cases (wrappers, host spelling), and the sites a space's own copy adds.

const LINK_ONLY_CASES: &str = include_str!("../../browser-action-policy/test/link-only-cases.json");

impl EmbeddedControllerFixture {
    /// A step of Octo's whose document is redirected to `url`: the step's
    /// guard decides before the request leaves the browser.
    fn click_redirected_to(&self, url: &str) -> Output {
        let snapshot_id = self.snapshot_id_in("redirects-to-link-only");
        let mut command = self.command_for(
            "redirects-to-link-only",
            "page-target",
            "POST",
            "/v1/click",
            Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
        );
        command
            .0
            .env("INSTAFY_SHARED_BROWSER_FAKE_REDIRECT_URL", url);
        command.output().expect("run the redirected click")
    }

    /// A step of Octo's whose document loads `url` and is answered with the
    /// Memento `Link` header `link`.
    fn click_answered_with(&self, url: &str, link: &str) -> Output {
        let snapshot_id = self.snapshot_id_in("answers-with-link-header");
        let mut command = self.command_for(
            "answers-with-link-header",
            "page-target",
            "POST",
            "/v1/click",
            Some(&json!({ "index": 0, "snapshotId": snapshot_id }).to_string()),
        );
        command
            .0
            .env("INSTAFY_SHARED_BROWSER_FAKE_REDIRECT_URL", url)
            .env("INSTAFY_SHARED_BROWSER_FAKE_ANSWER_LINK", link);
        command.output().expect("run the answered click")
    }

    fn write_space_link_only(&self, content: &str) {
        std::fs::create_dir_all(self.space_link_only.parent().expect("space copy folder"))
            .expect("space copy folder");
        std::fs::write(&self.space_link_only, content).expect("write the space's copy");
    }
}

/// A case's address, with a long case's `{pad}` written out.
fn link_only_case_url(case: &JsonValue) -> String {
    let url = case["url"].as_str().expect("case url");
    match case.get("pad") {
        Some(pad) => url.replace(
            "{pad}",
            &pad["text"]
                .as_str()
                .expect("pad text")
                .repeat(pad["times"].as_u64().expect("pad times") as usize),
        ),
        None => url.to_string(),
    }
}

/// A case is refused when its site is "no-agents" (its kind when left out);
/// a "no-reuse" site, whose terms bar copying and not reading, loads. With
/// the space's copy, a bundled case expects its `withSpaceCopy` where it has
/// one.
fn check_link_only_case(
    fixture: &EmbeddedControllerFixture,
    case: &JsonValue,
    with_space_copy: bool,
    authority_since: &mut std::time::Instant,
) {
    // The fixture's authority lasts a minute and the table can take longer:
    // a fresh one every half minute.
    if authority_since.elapsed() > std::time::Duration::from_secs(30) {
        fixture.prepare_routine_start("page-target");
        *authority_since = std::time::Instant::now();
    }
    let full_url = link_only_case_url(case);
    let url = case["url"].as_str().expect("case url");
    let expected = match case.get("withSpaceCopy") {
        Some(override_case) if with_space_copy => override_case,
        _ => case,
    };
    let refused_site = expected["site"]
        .as_str()
        .filter(|_| expected["kind"].as_str() != Some("no-reuse"));
    std::fs::remove_file(&fixture.fetch_log).ok();
    let output = fixture.click_redirected_to(&full_url);
    match refused_site {
        Some(site) => {
            let refused = failure_of(&output);
            let via: Vec<&str> = expected["via"]
                .as_array()
                .map(|via| via.iter().filter_map(JsonValue::as_str).collect())
                .unwrap_or_default();
            let named = if via.is_empty() {
                site.to_string()
            } else {
                format!("{site} (its copy on {})", via.join(", then "))
            };
            assert!(
                refused.contains(&format!(
                    "led to {named}, which is link-only, so it was not opened"
                )),
                "{url}: {refused}"
            );
            assert_eq!(
                fixture.fetch_answers(),
                vec![("Fetch.failRequest".to_string(), "request-main".to_string())],
                "{url}"
            );
        }
        None => {
            assert!(
                output.status.success(),
                "{url}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                fixture.fetch_answers(),
                vec![(
                    "Fetch.continueRequest".to_string(),
                    "request-main".to_string()
                )],
                "{url}"
            );
        }
    }
}

#[test]
fn every_case_in_the_readers_shared_table_is_stopped_or_let_through_at_the_redirect_hop() {
    let cases: JsonValue = serde_json::from_str(LINK_ONLY_CASES).expect("cases JSON");
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let mut authority_since = std::time::Instant::now();
    let bundled = cases["bundled"].as_array().expect("bundled cases");
    let space_cases = cases["spaceCopy"]["cases"].as_array().expect("space cases");
    // Both kinds are in the table: sites refused and sites that load (the
    // bundled list bars agents on every site, so a "no-reuse" one comes from
    // the space's copy).
    for kind in ["no-agents", "no-reuse"] {
        assert!(
            space_cases
                .iter()
                .chain(bundled.iter().filter_map(|case| case.get("withSpaceCopy")))
                .any(|case| case["site"].is_string()
                    && case["kind"].as_str().unwrap_or("no-agents") == kind),
            "{kind}"
        );
    }
    for case in bundled {
        check_link_only_case(&fixture, case, false, &mut authority_since);
    }
    // With the space's copy, its additions hold too, and the bundled list
    // still does: a copy can make a site stricter, never looser.
    fixture.write_space_link_only(&cases["spaceCopy"]["list"].to_string());
    for case in space_cases {
        check_link_only_case(&fixture, case, false, &mut authority_since);
    }
    for case in bundled {
        check_link_only_case(&fixture, case, true, &mut authority_since);
    }
}

#[test]
fn octo_never_opens_a_translator_cache_or_archive_copy_of_a_link_only_site() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    for (path, url, named) in [
        (
            "/v1/tabs/open",
            "https://www-booking-com.translate.goog/hotel?_x_tr_sl=auto",
            "Booking.com (its copy on Google Translate's page proxy)",
        ),
        (
            "/v1/navigate",
            "https://web.archive.org/web/2024/https://www.amazon.de/dp/1",
            "Amazon (its copy on the Wayback Machine)",
        ),
        (
            "/v1/navigate",
            "https://archive.ph/newest/https://www.airbnb.com/rooms/1",
            "Airbnb (its copy on archive.today)",
        ),
    ] {
        let error = failure_of(&fixture.call(
            "safe",
            "POST",
            path,
            Some(&json!({ "url": url }).to_string()),
        ));
        assert!(
            error.contains(&format!("{named} is link-only: Octo never opens it")),
            "{url}: {error}"
        );
    }
    assert!(fixture.browser_tabs().is_empty());
    // A wrapper's copy of another site, and the wrapper itself, are not
    // link-only.
    for url in [
        "https://web.archive.org/web/2024/https://example.test/report",
        "https://www-example-test.translate.goog/report",
    ] {
        let opened = fixture.open_tab(url);
        assert!(opened.to_string().contains("tabId"), "{url}: {opened}");
    }
}

#[test]
fn the_spaces_copy_of_the_list_adds_sites_and_never_removes_a_bundled_one() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let navigate = |url: &str| {
        fixture.call(
            "safe",
            "POST",
            "/v1/navigate",
            Some(&json!({ "url": url }).to_string()),
        )
    };
    // Without a copy, a site only a space lists is opened.
    payload_of(&navigate("https://www.shop.example/item"));

    // The space's copy adds a site and a wrapper; a copy without Booking.com
    // does not unlist it.
    fixture.write_space_link_only(
        &json!({
            "schema": "instafy.link-only-sites@1",
            "sites": [{ "name": "Example Shop", "match": ["shop.example"], "why": "terms bar AI agents" }],
            "wrappers": [{ "name": "Example proxy", "match": ["proxy.example"], "embeds": ["subdomain"] }],
        })
        .to_string(),
    );
    for (url, named) in [
        ("https://www.shop.example/item", "Example Shop"),
        (
            "https://www.booking.com.proxy.example/",
            "Booking.com (its copy on Example proxy)",
        ),
        ("https://www.booking.com/hotel/fixture.html", "Booking.com"),
    ] {
        let error = failure_of(&navigate(url));
        assert!(
            error.contains(&format!("{named} is link-only: Octo never opens it")),
            "{url}: {error}"
        );
    }
    let status = payload_of(&fixture.call("safe", "GET", "/v1/status", None));
    assert!(status.get("linkOnlyListWarnings").is_none(), "{status}");

    // A copy that is not a list, or not a plain file, is left out with a
    // warning, and the bundled list still applies.
    let outside = fixture.hostile_cwd.join("elsewhere.json");
    std::fs::write(
        &outside,
        r#"{"schema":"instafy.link-only-sites@1","sites":[{"name":"Linked","match":["linked.example"]}]}"#,
    )
    .expect("a file elsewhere");
    for (copy, why) in [
        ("{ not json", "is not valid JSON"),
        (
            r#"{"schema":"instafy.link-only-sites@2","sites":[]}"#,
            "schema is not instafy.link-only-sites@1",
        ),
        ("link", "could not be read"),
    ] {
        std::fs::remove_file(&fixture.space_link_only).ok();
        if copy == "link" {
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, &fixture.space_link_only).expect("link the copy");
            #[cfg(not(unix))]
            continue;
        } else {
            fixture.write_space_link_only(copy);
        }
        let error = failure_of(&navigate("https://www.booking.com/hotel/fixture.html"));
        assert!(
            error.contains("Booking.com is link-only"),
            "{copy}: {error}"
        );
        payload_of(&navigate("https://www.shop.example/item"));
        payload_of(&navigate("https://linked.example/"));
        let status = payload_of(&fixture.call("safe", "GET", "/v1/status", None));
        let warnings = status["linkOnlyListWarnings"].to_string();
        assert!(warnings.contains(why), "{copy}: {status}");
        assert!(
            warnings.contains("the bundled list still applies"),
            "{copy}: {status}"
        );
        assert!(
            !warnings.contains("not json"),
            "the copy's text is not repeated: {status}"
        );
    }
}

#[test]
fn octos_step_never_loads_a_page_that_says_it_is_a_copy_of_a_link_only_site() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let answer = |name: &str| (format!("Fetch.continueRequest"), name.to_string());
    // A short archive address names no site; the answer's Memento header
    // says which page it copies, and the copy is stopped before it renders.
    for in_tab in [false, true] {
        if in_tab {
            fixture.open_tab("https://example.test/hotel");
        }
        std::fs::remove_file(&fixture.fetch_log).ok();
        let refused = failure_of(&fixture.click_answered_with(
            "https://archive.ph/AbCdE",
            r#"<https://www.booking.com/hotel/x.html>; rel="original", <https://archive.ph/timegate/https://www.booking.com/hotel/x.html>; rel="timegate""#,
        ));
        assert!(
            refused.contains(
                "led to Booking.com (a page that says it is a copy of it), which is link-only, so it was not opened"
            ),
            "in a tab: {in_tab}: {refused}"
        );
        assert_eq!(
            fixture.fetch_answers(),
            vec![
                answer("request-main"),
                ("Fetch.failRequest".to_string(), "response-main".to_string())
            ],
            "in a tab: {in_tab}"
        );
    }
    // A copy of another site, and an answer that names no original, load.
    for link in [
        r#"<https://example.test/report>; rel="original""#,
        r#"<https://www.booking.com/>; rel="timegate""#,
        "",
    ] {
        std::fs::remove_file(&fixture.fetch_log).ok();
        payload_of(&fixture.click_answered_with("https://archive.ph/FgHiJ", link));
        assert_eq!(
            fixture.fetch_answers(),
            vec![answer("request-main"), answer("response-main")],
            "{link}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_space_copy_too_large_to_read_or_that_is_a_pipe_is_left_out_and_the_bundled_list_still_applies()
{
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_routine_start("page-target");
    let navigate = |url: &str| {
        fixture.call(
            "safe",
            "POST",
            "/v1/navigate",
            Some(&json!({ "url": url }).to_string()),
        )
    };
    let space_copy = |about: String| {
        json!({
            "schema": "instafy.link-only-sites@1",
            "about": about,
            "sites": [{ "name": "Example Shop", "match": ["shop.example"], "why": "terms bar AI agents" }],
        })
        .to_string()
    };
    // Within the bound, the copy's site counts.
    fixture.write_space_link_only(&space_copy("a space's additions".to_string()));
    assert!(
        failure_of(&navigate("https://www.shop.example/item"))
            .contains("Example Shop is link-only")
    );

    // Over 256 KiB, the copy is left out and the bundled list still applies.
    fixture.write_space_link_only(&space_copy("x".repeat(300 * 1024)));
    // A named pipe in its place is not waited on: no writer ever opens it.
    let pipe = fixture.hostile_cwd.join("link-only-pipe");
    let c_path = std::ffi::CString::new(pipe.as_os_str().as_encoded_bytes()).expect("pipe path");
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    for case in ["too large", "pipe"] {
        if case == "pipe" {
            std::fs::remove_file(&fixture.space_link_only).expect("remove the large copy");
            std::fs::rename(&pipe, &fixture.space_link_only).expect("put the pipe in its place");
        }
        let error = failure_of(&navigate("https://www.booking.com/hotel/fixture.html"));
        assert!(
            error.contains("Booking.com is link-only"),
            "{case}: {error}"
        );
        payload_of(&navigate("https://www.shop.example/item"));
        let status = payload_of(&fixture.call("safe", "GET", "/v1/status", None));
        let warnings = status["linkOnlyListWarnings"].to_string();
        assert!(
            warnings.contains("is not a file of at most 256 KiB")
                && warnings.contains("the bundled list still applies"),
            "{case}: {status}"
        );
    }
}

/// Live drive, Oct 28: Octo's reply quoted "net::ERR_TUNNEL_CONNECTION_FAILED",
/// the raw text of a navigation the network did not deliver. The result now
/// leads with a plain reason and keeps the code only in `error.details`.
#[test]
fn a_page_the_network_did_not_deliver_fails_with_a_plain_reason_and_the_code_only_in_details() {
    use std::os::unix::process::ExitStatusExt;
    // The exact stderr of that run's failed navigation.
    let stderr = "Shared Browser command failed: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://roborock.com/\nCall log:\n  - navigating to \"https://roborock.com/\", waiting until \"domcontentloaded\"\n";
    let error = controller_failure(
        std::process::ExitStatus::from_raw(1 << 8),
        stderr.as_bytes(),
        b"",
    );
    let result = failed_tool_result(&format!("{error:#}"));
    assert_eq!(result.is_error, Some(true));
    let text = &result.content[0].raw.as_text().expect("text content").text;
    assert!(
        text.starts_with("Instafy's browser couldn't reach that site"),
        "{text}"
    );
    assert!(!text.contains("net::"), "{text}");
    assert!(!text.contains("ERR_"), "{text}");
    assert!(!text.contains("page.goto"), "{text}");
    assert_eq!(
        result.structured_content,
        Some(json!({
            "error": {
                "reason": SITE_UNREACHABLE_REASON,
                "details": "net::ERR_TUNNEL_CONNECTION_FAILED",
            }
        }))
    );
}

#[test]
fn network_codes_map_to_a_few_plain_reasons() {
    let reason =
        |message: &str| network_failure(message).map(|failure| (failure.reason, failure.code));
    assert_eq!(
        reason("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nowhere.example/"),
        Some((
            SITE_NOT_FOUND_REASON,
            "net::ERR_NAME_NOT_RESOLVED".to_string()
        ))
    );
    assert_eq!(
        reason("page.goto: net::ERR_CERT_DATE_INVALID at https://old.example/"),
        Some((
            SITE_INSECURE_REASON,
            "net::ERR_CERT_DATE_INVALID".to_string()
        ))
    );
    assert_eq!(
        reason("net::ERR_SSL_PROTOCOL_ERROR"),
        Some((
            SITE_INSECURE_REASON,
            "net::ERR_SSL_PROTOCOL_ERROR".to_string()
        ))
    );
    assert_eq!(
        reason("page.goto: net::ERR_TOO_MANY_REDIRECTS at https://loop.example/"),
        Some((
            SITE_REDIRECT_LOOP_REASON,
            "net::ERR_TOO_MANY_REDIRECTS".to_string()
        ))
    );
    for code in [
        "ERR_CONNECTION_TIMED_OUT",
        "ERR_CONNECTION_REFUSED",
        "ERR_PROXY_CONNECTION_FAILED",
        "ERR_ADDRESS_UNREACHABLE",
    ] {
        assert_eq!(
            reason(&format!("page.goto: net::{code} at https://down.example/")),
            Some((SITE_UNREACHABLE_REASON, format!("net::{code}"))),
        );
    }
    // Not a network code: the controller's own error text stays.
    assert_eq!(reason("page.goto: Timeout 30000ms exceeded"), None);
    assert_eq!(reason("net::ERR_"), None);
    assert_eq!(reason(&format!("net::ERR_{}", "X".repeat(80))), None);
    let other =
        failed_tool_result("Shared Browser command exited with exit status: 1: stale snapshot");
    assert_eq!(
        other.content[0].raw.as_text().expect("text content").text,
        "Shared Browser action failed: Shared Browser command exited with exit status: 1: stale snapshot"
    );
    assert_eq!(other.structured_content, None);
}

#[test]
fn remembers_which_chat_last_held_each_page_within_a_bound() {
    let first = format!("PAGE_{}", Uuid::new_v4().simple());
    let chat_a = Uuid::new_v4();
    let chat_b = Uuid::new_v4();
    assert!(!page_left_by_another_conversation(&first, Some(chat_a)));
    assert!(!page_left_by_another_conversation(&first, Some(chat_a)));
    assert!(page_left_by_another_conversation(&first, Some(chat_b)));
    // A run with no chat neither asks nor records.
    assert!(!page_left_by_another_conversation(&first, None));
    assert!(page_left_by_another_conversation(&first, Some(chat_a)));
    // Only the newest pages are kept: an old page is forgotten, not misread.
    // (On a value of its own: the machine's memory is shared with other tests.)
    let mut pages = PageConversations::default();
    assert!(!pages.record(&first, chat_a));
    for _ in 0..MAX_PAGE_CONVERSATIONS {
        let other = format!("PAGE_{}", Uuid::new_v4().simple());
        assert!(!pages.record(&other, Uuid::new_v4()));
    }
    assert!(!pages.record(&first, chat_b));
}

/// Downloads are denied in this browser, so `goto` on a file to download fails
/// with `net::ERR_ABORTED`, as does a navigation another one replaced. The
/// site answered both times: the reason must not say it could not be reached,
/// nor may a code that is not about the connection.
#[test]
fn a_stopped_or_refused_page_load_does_not_say_the_site_was_unreachable() {
    let aborted = network_failure("page.goto: net::ERR_ABORTED at https://example.test/report.pdf")
        .expect("a network code");
    assert!(
        !aborted.reason.contains("couldn't reach"),
        "{}",
        aborted.reason
    );
    assert!(aborted.reason.contains("download"), "{}", aborted.reason);
    assert_eq!(aborted.code, "net::ERR_ABORTED");
    for code in [
        "ERR_BLOCKED_BY_RESPONSE",
        "ERR_BLOCKED_BY_CLIENT",
        "ERR_INVALID_URL",
        "ERR_HTTP_RESPONSE_CODE_FAILURE",
    ] {
        let failure = network_failure(&format!("page.goto: net::{code} at https://example.test/"))
            .expect("a network code");
        assert!(
            !failure.reason.contains("couldn't reach"),
            "{code}: {}",
            failure.reason
        );
        assert!(
            !failure.reason.contains("ERR_"),
            "{code}: {}",
            failure.reason
        );
        assert_eq!(failure.code, format!("net::{code}"));
    }
    // Failures of the connection itself still say so.
    for code in [
        "ERR_TUNNEL_CONNECTION_FAILED",
        "ERR_CONNECTION_RESET",
        "ERR_CONNECTION_CLOSED",
        "ERR_EMPTY_RESPONSE",
        "ERR_TIMED_OUT",
        "ERR_UNSAFE_PORT",
        "ERR_INTERNET_DISCONNECTED",
    ] {
        let failure = network_failure(&format!("page.goto: net::{code} at https://example.test/"))
            .expect("a network code");
        assert_eq!(failure.reason, SITE_UNREACHABLE_REASON, "{code}");
    }
}

#[test]
fn card_sites_count_only_as_plain_public_host_names() {
    let payload = |sites: JsonValue| json!({ "metadata": { "browserCardSites": sites } });
    assert_eq!(
        card_site_origins_from_payload(&payload(json!([
            "www.visitlisboa.com",
            "carris.pt",
            "www.visitlisboa.com"
        ]))),
        vec![
            "https://www.visitlisboa.com".to_string(),
            "https://carris.pt".to_string()
        ]
    );
    // Addresses, IP literals, local names, ports, capitals and odd shapes
    // are left out, one by one.
    for refused in [
        "https://example.com",
        "example.com/path",
        "example.com:8443",
        "127.0.0.1",
        "10.0.0.7",
        "localhost",
        "printer.local",
        "router.home.arpa",
        "intranet",
        "Example.com",
        "-bad.example.com",
        "exa_mple.com",
        "",
    ] {
        assert!(
            card_site_origins_from_payload(&payload(json!([refused]))).is_empty(),
            "{refused}"
        );
    }
    assert!(card_site_origins_from_payload(&payload(json!([1, null, {}]))).is_empty());
    // A list longer than a chat's cards could name counts for nothing.
    let many: Vec<String> = (0..9).map(|n| format!("site{n}.example.com")).collect();
    assert!(card_site_origins_from_payload(&payload(json!(many))).is_empty());
    assert!(card_site_origins_from_payload(&json!({ "metadata": {} })).is_empty());
}

#[tokio::test]
async fn a_run_starts_with_the_sites_of_the_cards_the_person_pressed_on_their_page() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    let cancel_signal = JobCancelSignal::new();
    let card_sites = vec!["https://www.visitlisboa.com".to_string()];
    let guard = SharedBrowserAgentControlGuard::acquire_continuing(
        path.clone(),
        approval_dir.clone(),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        None,
        &card_sites,
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire run");
    let marker: JsonValue =
        serde_json::from_slice(&std::fs::read(&path).expect("marker")).expect("marker JSON");
    let state: JsonValue = serde_json::from_slice(
        &std::fs::read(approval_dir.join("state.json")).expect("starting state"),
    )
    .expect("state JSON");
    // The card's site is approved on the person's page, as an answered site
    // prompt leaves it; nothing else changes: routine browsing stays off, so
    // every step still asks as before.
    assert_eq!(
        state["approvedOrigins"],
        json!(["https://www.visitlisboa.com"])
    );
    assert_eq!(state["routineBrowsingAllowed"], false);
    for key in ["ownerId", "runId", "initiatorUserId", "browserPageId"] {
        assert_eq!(state[key], marker[key], "{key}");
    }
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
}

/// Drive, Oct 28: "Allow this browser action? The AI agent is waiting to
/// click 'Reject all'." A cookie banner's refusal shares nothing, so it
/// never asks, in Ask too; the same words outside a banner still do.
#[test]
fn a_cookie_banners_refusal_never_asks_while_the_same_words_elsewhere_still_do() {
    for mode in ["cookie-reject", "cookie-reject-pt"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            &["https://example.test"],
            &[],
        );
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(requests.is_empty(), "{mode} asked: {requests:?}");
        assert!(
            fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }
    for mode in ["reject-outside-banner"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            &["https://example.test"],
            &[],
        );
        assert_eq!(requests.len(), 1, "{mode} did not ask");
        assert_eq!(requests[0]["operation"], "click", "{mode}");
        assert!(!output.status.success(), "{mode} ran although denied");
    }
}

/// Accepting a cookie banner is the person's step: its "Accept all" button,
/// its "aceitar e continuar" link and a "Consent" button are refused before
/// any prompt, in Ask, under routine browsing and on a run that starts in it,
/// and nothing is clicked. Before, the link went through as plain navigation,
/// the "Accept all" button asked, and "Consent" was clicked under routine
/// browsing without a prompt.
#[test]
fn a_cookie_banners_accept_is_refused_without_a_prompt_even_as_a_link() {
    for mode in ["cookie-accept", "cookie-accept-link", "cookie-consent"] {
        // Ask mode, with the site approved.
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(!output.status.success(), "{mode} ask mode");
        assert!(
            requests.is_empty(),
            "{mode} prompted in ask mode: {requests:?}"
        );
        assert!(
            failure_of(&output).contains("[step_refused_consent]"),
            "{mode}: {}",
            failure_of(&output)
        );
        assert!(
            !fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );

        // Routine browsing.
        let fixture = EmbeddedControllerFixture::new();
        let snapshot = fixture.routine_snapshot(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot["snapshotId"] }).to_string();
        let output = fixture
            .command_for(mode, "page-target", "POST", "/v1/click", Some(&body))
            .output()
            .expect("refused routine step");
        assert!(!output.status.success(), "{mode} routine");
        assert!(
            failure_of(&output).contains("[step_refused_consent]"),
            "{mode} routine"
        );
        assert!(
            !fixture.approval_dir.join("request.json").exists(),
            "{mode} routine"
        );
        assert!(
            !fixture.action_log().contains("\"type\":\"click\""),
            "{mode} routine"
        );

        // A run that starts in routine browsing.
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for(mode, "page-target", "POST", "/v1/click", Some(&body)),
            &["allow_once"],
        );
        assert!(!output.status.success(), "{mode} routine start");
        assert!(requests.is_empty(), "{mode} prompted on a routine start");
        assert!(
            failure_of(&output).contains("[step_refused_consent]"),
            "{mode} routine start"
        );
    }
}

/// An accept limited to the necessary cookies ("Accept only necessary",
/// "Aceitar apenas necessários") refuses the rest, so it is never refused as an
/// accept: it asks once, under routine browsing too, and runs when allowed.
/// Before, both were refused, so a person's "refuse them" could not be done.
#[test]
fn a_cookie_banners_accept_of_only_the_necessary_cookies_asks_once() {
    for mode in ["cookie-accept-necessary", "cookie-accept-necessary-pt"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot = fixture.routine_snapshot(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot["snapshotId"] }).to_string();
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for(mode, "page-target", "POST", "/v1/click", Some(&body)),
            &["allow_once"],
        );
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(requests.len(), 1, "{mode} did not ask once: {requests:?}");
        assert_eq!(requests[0]["operation"], "click", "{mode}");
        assert!(
            fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }
}

/// A prompt says what the step does in the words on the page: the text a
/// control shows comes first and each of its names is cut on its own (before,
/// the hidden name led and the pair was cut as one, so the shown text was
/// lost), and a form step lists the fields it sends, never their values.
#[test]
fn a_prompt_leads_with_the_shown_text_and_lists_the_fields_a_form_sends() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("learn-more");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "learn-more",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0]["display"]["label"],
        "Change something: Learn More \u{2192} (also called \"Learn More: Configure your consents\")"
    );
    assert!(
        fixture.action_log().contains(
            r#"Click \"Learn More →\" (also called \"Learn More: Configure your consents\")"#
        ),
        "{}",
        fixture.action_log()
    );

    for (mode, sends) in [
        (
            "submit-order",
            "Customer name, Telephone, E-mail address, Pizza Size, Delivery instructions",
        ),
        (
            "submit-order-many",
            "Customer name, Telephone, E-mail address, Pizza Size, Pizza Toppings and 2 more",
        ),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            &["https://example.test"],
            &["deny"],
        );
        assert!(!output.status.success(), "{mode} ran although denied");
        assert_eq!(requests.len(), 1, "{mode}");
        assert_eq!(
            requests[0]["display"]["label"],
            format!("Change something: Submit order \u{b7} Sends: {sends}"),
            "{mode}"
        );
    }
}

/// The refusal that never asks may not send a form anywhere, not even to
/// the page's own site.
#[test]
fn a_cookie_banners_refusal_lets_no_form_post_leave_the_tab() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("cookie-reject-posts");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "cookie-reject-posts",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &[],
    );
    assert!(requests.is_empty(), "{requests:?}");
    let refused = failure_of(&output);
    assert!(
        refused.contains("the page sent a form to https://example.test/, which the step was not approved to send to"),
        "{refused}"
    );
}
