import type { WebContents } from "electron";

import {
  PERSONAL_BROWSER_SECURITY_FINGERPRINT_FIELDS,
  type PersonalBrowserActivationTarget,
  type PersonalBrowserActionDescriptor,
  type PersonalBrowserEditableDescriptor,
} from "./personalBrowserSecurity";
import {
  CREDENTIAL_CONTEXT_SOURCE,
  KNOWN_SECRET_PATTERN_SOURCES,
  MASKED_TEXT_SOURCE,
  PLACEHOLDER_SOURCE,
} from "./personalBrowserRedaction";

const PERSONAL_BROWSER_ISOLATED_WORLD_ID = 987;

export type PersonalBrowserInteractiveElement = {
  index: number;
  tag: string;
  role?: string;
  name?: string;
  type?: string;
  disabled: boolean;
  identity: string;
  descriptor: PersonalBrowserTargetDescriptor;
};

/**
 * Yes/no answers computed inside the page. Values are tested where they live
 * and never returned, so a key shown in a read-only field never reaches the
 * main process.
 */
export type PersonalBrowserPageSecretSignals = {
  credentialContext: boolean;
  secretField: boolean;
  secretCode: boolean;
  maskedNearReveal: boolean;
};

export type PersonalBrowserPageSnapshot = {
  url: string;
  title: string;
  text: string;
  interactive: PersonalBrowserInteractiveElement[];
  documentToken: string;
  signals?: PersonalBrowserPageSecretSignals;
  capturedAt: string;
};

export type PersonalBrowserTargetDescriptor = PersonalBrowserActionDescriptor &
  PersonalBrowserEditableDescriptor & {
    found: boolean;
    identity?: string;
    disabled?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  };

type PersonalBrowserTarget = {
  index: number;
};

export type PersonalBrowserTargetExpectation = {
  identity: string;
  securityFingerprint: string;
};

export type PersonalBrowserTargetMutationResult = {
  descriptor: PersonalBrowserTargetDescriptor;
  targetChanged: boolean;
};

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Runs inside the page. Every check returns a boolean; no field value, code
// block text or masked text is ever part of the result. Open shadow roots are
// searched too, because querySelectorAll does not enter them.
const PAGE_SECRET_SIGNAL_SCRIPT = `
    const secretPatternSources = ${serializeForScript(KNOWN_SECRET_PATTERN_SOURCES)};
    const credentialContextPattern = new RegExp(${serializeForScript(CREDENTIAL_CONTEXT_SOURCE)}, "iu");
    const placeholderPattern = new RegExp(${serializeForScript(PLACEHOLDER_SOURCE)}, "i");
    const maskedTextPattern = new RegExp(${serializeForScript(MASKED_TEXT_SOURCE)}, "u");
    const revealLabelPattern = /(?<![\\p{L}\\p{N}])(?:reveal|show|view|copy|unhide|display|anzeigen|einblenden|kopieren|zeigen|ansehen)(?![\\p{L}\\p{N}])|(?<![\\p{L}])eye(?:[-_]?(?:icon|open|off|slash|closed|fill|outline))?(?![\\p{L}])|(?<![\\p{L}])eye(?=icon|open|off|slash)|visibility|clipboard/iu;
    const uuidValuePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const hexValuePattern = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
    const valueEntropy = (value) => {
      const counts = new Map();
      for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
      let entropy = 0;
      for (const count of counts.values()) {
        const probability = count / value.length;
        entropy -= probability * Math.log2(probability);
      }
      return entropy;
    };
    const looksLikeSecretValue = (raw, credentialContext) => {
      if (typeof raw !== "string") return false;
      const value = raw.trim();
      if (value.length < 16 || value.length > 16_384 || placeholderPattern.test(value)) return false;
      if (secretPatternSources.some((source) => new RegExp(source).test(value))) return true;
      if (/\\s/.test(value) || value.length < 20 || value.length > 512) return false;
      if (!credentialContext && (uuidValuePattern.test(value) || hexValuePattern.test(value))) return false;
      return /[A-Za-z]/.test(value) && /[0-9]/.test(value) && valueEntropy(value) >= 3.5;
    };
    const scanElements = (visit) => {
      const roots = [document];
      let scanned = 0;
      while (roots.length > 0 && scanned < 20_000) {
        const root = roots.shift();
        const elements = typeof root?.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
        for (const element of elements) {
          scanned += 1;
          if (visit(element) === true) return true;
          if (element && element.shadowRoot && typeof element.shadowRoot.querySelectorAll === "function") {
            roots.push(element.shadowRoot);
          }
          if (scanned >= 20_000) break;
        }
      }
      return false;
    };
    const elementTag = (element) => typeof element?.tagName === "string" ? element.tagName.toUpperCase() : "";
    const elementAttribute = (element, name) => typeof element?.getAttribute === "function" ? element.getAttribute(name) : null;
    const elementText = (element) => clean(element?.textContent ?? element?.innerText ?? "", 2_000);
    const isDialog = (element) => elementTag(element) === "DIALOG"
      || ["dialog", "alertdialog"].includes(elementAttribute(element, "role"))
      || elementAttribute(element, "aria-modal") === "true";
    const pageSecretSignals = () => {
      try {
        const labelTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "LEGEND", "TH", "LABEL", "DT", "CAPTION"]);
        const credentialContext = credentialContextPattern.test(clean(document.title, 1_000)) || scanElements((element) => {
          const label = labelTags.has(elementTag(element)) || elementAttribute(element, "role") === "heading"
            ? elementText(element)
            : isDialog(element)
              ? clean(elementAttribute(element, "aria-label"))
              : "";
          return Boolean(label) && credentialContextPattern.test(label);
        });
        const codeTags = new Set(["CODE", "PRE", "KBD", "SAMP", "OUTPUT"]);
        let secretField = false;
        let secretCode = false;
        let maskedNearReveal = false;
        scanElements((element) => {
          const tag = elementTag(element);
          if (!secretField && (tag === "INPUT" || tag === "TEXTAREA")) {
            const type = String(element.type || elementAttribute(element, "type") || "").toLowerCase();
            const readOnly = element.readOnly === true || elementAttribute(element, "readonly") !== null
              || element.disabled === true || elementAttribute(element, "disabled") !== null;
            if (readOnly && type !== "password" && type !== "hidden" && looksLikeSecretValue(element.value, credentialContext)) {
              secretField = true;
            }
          }
          if (!secretCode && codeTags.has(tag) && looksLikeSecretValue(elementText(element), credentialContext)) {
            secretCode = true;
          }
          if (!maskedNearReveal && (tag === "BUTTON" || tag === "A" || elementAttribute(element, "role") === "button"
              || elementAttribute(element, "onclick") !== null)) {
            const label = [
              elementAttribute(element, "aria-label"), elementAttribute(element, "title"),
              elementAttribute(element, "class"), elementAttribute(element, "data-icon"), elementText(element),
            ].filter(Boolean).join(" ");
            // A link to another page counts only when its own label names a
            // credential; "View invoice" beside a masked card number does not.
            let pageLink = false;
            if (tag === "A") {
              try {
                pageLink = ["http:", "https:"].includes(new URL(String(element.href || "")).protocol)
                  && !String(elementAttribute(element, "href") || "").startsWith("#");
              } catch {
                pageLink = false;
              }
            }
            if (revealLabelPattern.test(label) && (!pageLink || credentialContextPattern.test(label))) {
              let ancestor = element.parentElement;
              for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
                // Only a small container around the control, never a whole card or page.
                const ancestorText = typeof ancestor.textContent === "string" ? ancestor.textContent : (ancestor.innerText ?? "");
                if (ancestorText.length <= 400 && maskedTextPattern.test(elementText(ancestor))) {
                  maskedNearReveal = true;
                  break;
                }
              }
            }
          }
          return secretField && secretCode && maskedNearReveal;
        });
        return { credentialContext, secretField, secretCode, maskedNearReveal };
      } catch {
        // The host withholds the page when the answers are missing.
        return null;
      }
    };
`;

function buildPageScript(argumentsValue: unknown, body: string): string {
  return `(() => {
    "use strict";
    const args = ${serializeForScript(argumentsValue)};
    const securityFingerprintFields = ${serializeForScript(PERSONAL_BROWSER_SECURITY_FINGERPRINT_FIELDS)};
    const interactiveSelector = [
      "a[href]", "button", "input:not([type='hidden'])", "textarea", "select",
      "[contenteditable='true']", "[role='button']", "[role='link']", "[role='textbox']",
      "[tabindex]:not([tabindex='-1'])",
      // Script-driven apps build menus, trees and rows from generic elements.
      "summary", "[role='menuitem']", "[role='menuitemcheckbox']", "[role='menuitemradio']",
      "[role='treeitem']", "[role='tab']", "[role='switch']", "[role='checkbox']", "[role='radio']",
      "[role='option']", "[aria-expanded]", "[aria-haspopup]:not([aria-haspopup='false'])", "[onclick]"
    ].join(",");
    const clean = (value, limit = 500) => typeof value === "string"
      ? value.replace(/\\s+/g, " ").trim().slice(0, limit)
      : "";
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < globalThis.innerHeight && rect.left < globalThis.innerWidth
        && style.visibility !== "hidden" && style.display !== "none"
        && style.pointerEvents !== "none";
    };
    ${PAGE_SECRET_SIGNAL_SCRIPT}
    const forbiddenTarget = (element) => element.matches("iframe, frame, object, embed");
    const candidates = () => Array.from(document.querySelectorAll(interactiveSelector))
      .filter((element) => element.ownerDocument === document && !forbiddenTarget(element) && visible(element));
    const registryName = "__instafyPersonalBrowserTargetRegistryV1";
    const existingRegistry = globalThis[registryName];
    const randomWords = new Uint32Array(4);
    globalThis.crypto.getRandomValues(randomWords);
    const registry = existingRegistry?.document === document
      ? existingRegistry
      : globalThis[registryName] = {
          document,
          documentToken: Array.from(randomWords, (word) => word.toString(16).padStart(8, "0")).join(""),
          targets: new WeakMap(),
          nextId: 1,
        };
    const targetIdentity = (element) => {
      let identity = registry.targets.get(element);
      if (!identity) {
        identity = registry.documentToken + ":personal-target-" + registry.nextId++;
        registry.targets.set(element, identity);
      }
      return identity;
    };
    const findTarget = () => {
      if (Number.isInteger(args.index) && args.index >= 0 && args.index < 500) {
        return candidates()[args.index] ?? null;
      }
      return null;
    };
    // Structure around the element. Ancestor facts and bounded text are
    // computed once per node in each run, so a page with hundreds of rows
    // stays fast. Text stays in the main process; it is never sent to the agent.
    const structureAttribute = (node, name) => typeof node?.getAttribute === "function" ? node.getAttribute(name) : null;
    const structureTag = (node) => typeof node?.tagName === "string" ? node.tagName.toUpperCase() : "";
    const structureHeadingSelector = "h1, h2, h3, h4, h5, h6, [role='heading'], legend, caption";
    const structureDialogSelector = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
    const SMALL_CONTAINER_CHARACTERS = 400;
    const areaOf = (node) => {
      const role = clean(structureAttribute(node, "role")).toLowerCase();
      const tag = structureTag(node);
      if (tag === "DIALOG" || role === "dialog" || role === "alertdialog" || structureAttribute(node, "aria-modal") === "true") return "dialog";
      if (tag === "SEARCH" || role === "search") return "search";
      const pagination = /pagination|pager|paginat|seitennavigation/i.test(
        [structureAttribute(node, "aria-label"), structureAttribute(node, "class"), structureAttribute(node, "data-testid")].filter(Boolean).join(" "),
      );
      if (pagination) return "pagination";
      if (tag === "NAV" || role === "navigation") return "nav";
      if (role === "menu" || role === "menubar") return role;
      if (role === "tree" || role === "tablist") return role;
      return "";
    };
    const rowOf = (node) => {
      const role = clean(structureAttribute(node, "role")).toLowerCase();
      return ["TR", "LI", "DT", "DD"].includes(structureTag(node)) || ["row", "listitem", "option", "gridcell", "treeitem", "article"].includes(role);
    };
    const dialogLabelOf = (node) => {
      const labelledBy = clean(structureAttribute(node, "aria-labelledby")).split(/\\s+/)
        .map((id) => id ? document.getElementById(id) : null).filter(Boolean)
        .map((label) => clean(label.textContent)).join(" ");
      const dialogHeading = typeof node.querySelector === "function" ? node.querySelector(structureHeadingSelector) : null;
      return clean(structureAttribute(node, "aria-label") || labelledBy || dialogHeading?.textContent || "", 200);
    };
    const emptyFacts = { areas: [], dialogLabel: "", row: null };
    const nodeFacts = new Map();
    // Enclosing areas (nearest first), the nearest dialog's label and the
    // nearest row, inherited from the parent's cached facts.
    const factsOf = (start) => {
      if (!start) return emptyFacts;
      const chain = [];
      let node = start;
      while (node && !nodeFacts.has(node) && chain.length < 200) {
        chain.push(node);
        node = node.parentElement;
      }
      let inherited = node && nodeFacts.has(node) ? nodeFacts.get(node) : emptyFacts;
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const current = chain[index];
        const area = areaOf(current);
        const facts = {
          areas: area && !inherited.areas.includes(area) ? [area, ...inherited.areas] : inherited.areas,
          dialogLabel: area === "dialog" ? dialogLabelOf(current) : inherited.dialogLabel,
          row: rowOf(current) ? current : inherited.row,
        };
        nodeFacts.set(current, facts);
        inherited = facts;
      }
      return nodeFacts.get(start) ?? emptyFacts;
    };
    const textFacts = new Map();
    const boundedText = (node) => {
      let facts = textFacts.get(node);
      if (!facts) {
        const raw = typeof node?.textContent === "string" ? node.textContent : "";
        facts = { text: clean(raw.slice(0, 4_000), 2_000), length: raw.length };
        textFacts.set(node, facts);
      }
      return facts;
    };
    let headingList = null;
    const headingsInOrder = () => {
      if (headingList === null) {
        try {
          headingList = Array.from(document.querySelectorAll(structureHeadingSelector)).filter((node) =>
            typeof node?.matches === "function" && node.matches(structureHeadingSelector) &&
            typeof node.compareDocumentPosition === "function");
        } catch {
          headingList = [];
        }
      }
      return headingList;
    };
    // The nearest heading before the element in document order, within six
    // levels of it and not inside a dialog the element is outside of.
    const nearestHeading = (element) => {
      if (typeof element?.compareDocumentPosition !== "function") return "";
      const list = headingsInOrder();
      let low = 0;
      let high = list.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const candidate = list[middle];
        // 4 is DOCUMENT_POSITION_FOLLOWING: the element comes after the heading.
        if (candidate === element || (candidate.compareDocumentPosition(element) & 4) !== 0) {
          found = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      let scope = element;
      for (let depth = 0; depth < 6 && scope.parentElement; depth += 1) scope = scope.parentElement;
      for (let index = found, steps = 0; index >= 0 && steps < 25; index -= 1, steps += 1) {
        const candidate = list[index];
        if (candidate === element) continue;
        if (typeof scope.contains !== "function" || !scope.contains(candidate)) return "";
        const dialog = typeof candidate.closest === "function" ? candidate.closest(structureDialogSelector) : null;
        if (dialog && !(typeof dialog.contains === "function" && dialog.contains(element))) continue;
        return clean(candidate.textContent ?? "", 200);
      }
      return "";
    };
    // The column header of the element's table cell, or the whole header row
    // for a row target.
    const columnHeader = (element, row) => {
      if (structureTag(row) !== "TR" || typeof row.closest !== "function") return "";
      const table = row.closest("table");
      if (!table) return "";
      const headerRow = table.tHead?.rows?.[0]
        ?? Array.from(table.rows ?? []).find((candidate) => typeof candidate.querySelector === "function" && candidate.querySelector("th"));
      if (!headerRow || headerRow === row) return "";
      if (element === row) {
        return clean(Array.from(headerRow.cells ?? []).map((cell) => cell.textContent ?? "").join(" "), 200);
      }
      const cell = typeof element.closest === "function" ? element.closest("td, th") : null;
      if (!cell || cell.parentElement !== row || !Number.isInteger(cell.cellIndex)) return "";
      return clean(headerRow.cells?.[cell.cellIndex]?.textContent ?? "", 200);
    };
    const describeStructure = (element, link) => {
      const parentFacts = factsOf(element.parentElement);
      const row = rowOf(element) ? element : parentFacts.row;
      const rowText = row ? clean(boundedText(row).text, 500) : "";
      const heading = nearestHeading(element);
      const header = row ? columnHeader(element, row) : "";
      // Masked text counts only in the element's row or a small container
      // around it, never a whole card or page.
      let nearMaskedText = false;
      const smallMasked = (node) => {
        const facts = boundedText(node);
        return facts.length <= SMALL_CONTAINER_CHARACTERS && maskedTextPattern.test(facts.text);
      };
      let node = element.parentElement;
      for (let depth = 0; node && depth < 3 && !nearMaskedText; depth += 1, node = node.parentElement) {
        nearMaskedText = smallMasked(node);
      }
      if (!nearMaskedText && row && row !== element) nearMaskedText = smallMasked(row);
      const contextLabel = clean([parentFacts.dialogLabel, heading, header, rowText].filter(Boolean).join(" · "), 200);
      const iconChild = typeof element.querySelector === "function" ? element.querySelector("svg, i, img, use") : null;
      const iconHint = clean([
        structureAttribute(element, "class"), structureAttribute(element, "data-icon"), structureAttribute(element, "data-testid"),
        structureAttribute(iconChild, "class"), structureAttribute(iconChild, "aria-label"), structureAttribute(iconChild, "alt"),
        structureAttribute(iconChild, "data-icon"), structureAttribute(iconChild, "href"),
      ].filter(Boolean).join(" "), 160);
      const expanded = structureAttribute(element, "aria-expanded") ?? structureAttribute(link, "aria-expanded");
      const popup = structureAttribute(element, "aria-haspopup");
      // A control that names the region it shows or hides, or a
      // Bootstrap-style collapse, dropdown or offcanvas toggle, opens part
      // of the page the way an aria-expanded opener does.
      const controlsRegion = clean(structureAttribute(element, "aria-controls"), 200)
        .split(/\\s+/)
        .some((id) => id && Boolean(document.getElementById(id)));
      const toggleKind = clean(structureAttribute(element, "data-bs-toggle") || structureAttribute(element, "data-toggle"), 32).toLowerCase();
      const pageToggle = ["collapse", "dropdown", "offcanvas", "sidebar"].includes(toggleKind);
      return {
        areas: parentFacts.areas.join(" "),
        menuOpener: expanded !== null || (popup !== null && popup !== "false") || controlsRegion || pageToggle,
        credentialContext: credentialContextPattern.test([parentFacts.dialogLabel, heading, header, rowText].join(" ")),
        row: Boolean(row),
        contextLabel,
        nearMaskedText,
        iconHint,
      };
    };
    const descriptor = (element) => {
      if (
        !(element instanceof Element) ||
        element.ownerDocument !== document ||
        forbiddenTarget(element)
      ) return { found: false };
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.max(0, Math.min(globalThis.innerWidth - 1, rect.x + rect.width / 2)),
        Math.max(0, Math.min(globalThis.innerHeight - 1, rect.y + rect.height / 2)),
      );
      if (
        !(hit instanceof Element) ||
        forbiddenTarget(hit) ||
        hit.closest("iframe, frame, object, embed") ||
        !(hit === element || element.contains(hit) || hit.contains(element))
      ) return { found: false };
      const link = element.closest("a[href]");
      // Native controls can belong to a non-ancestor form, or explicitly have
      // no owner despite being inside one. Use the browser's resolved owner.
      const formCandidate = "form" in element ? element.form : element.closest("form");
      const form = formCandidate instanceof HTMLFormElement ? formCandidate : null;
      const formControls = form ? Array.from(form.elements || []) : [];
      const isSubmitControl = (control) => control.form === form && (
        (control instanceof HTMLButtonElement && control.type === "submit") ||
        (control instanceof HTMLInputElement && ["submit", "image"].includes(control.type))
      );
      const submit = formControls.find(isSubmitControl) ?? null;
      const submitLabel = (control) => clean(
        control.getAttribute("aria-label") || control.textContent || control.getAttribute("value") || "",
        80,
      );
      const formSubmitLabels = clean(formControls.filter(isSubmitControl).map(submitLabel).filter(Boolean).join(" | "), 200);
      const editableTypes = ["", "text", "search", "email", "url", "tel", "number", "password", "date", "time", "datetime-local", "month", "week"];
      const formFieldCount = formControls.filter((control) =>
        control.form === form && (
          (control instanceof HTMLInputElement && editableTypes.includes(String(control.type || "").toLowerCase())) ||
          control instanceof HTMLTextAreaElement ||
          String(control.tagName || "").toUpperCase() === "SELECT"
        )).length;
      const isPasswordControl = (control) =>
        control instanceof HTMLInputElement && String(control.type || "").toLowerCase() === "password";
      const formPasswordCount = formControls.filter(isPasswordControl).length;
      const formHasPassword = formPasswordCount > 0;
      // The text field right before the form's first password field is the
      // account identifier of a sign-in form.
      const firstPassword = formControls.findIndex(isPasswordControl);
      const identifierCandidate = firstPassword > 0
        ? formControls.slice(0, firstPassword).reverse().find((control) =>
          control instanceof HTMLInputElement && ["", "text", "email", "tel"].includes(String(control.type || "").toLowerCase()))
        : null;
      const signInIdentifier = Boolean(identifierCandidate) && identifierCandidate === element;
      const formLabelledBy = clean(form?.getAttribute("aria-labelledby"))
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((label) => clean(label.textContent))
        .filter(Boolean)
        .join(" ");
      const formActionText = form instanceof HTMLFormElement
        ? clean(
            submit?.getAttribute("aria-label")
              || submit?.textContent
              || submit?.getAttribute("value")
              || form.getAttribute("aria-label")
              || formLabelledBy
              || form.getAttribute("title")
              || form.getAttribute("name")
              || "this form",
          )
        : "";
      const read = (name) => clean(element.getAttribute(name));
      const labelledBy = read("aria-labelledby")
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((label) => clean(label.textContent))
        .filter(Boolean)
        .join(" ");
      const associatedLabels = "labels" in element && element.labels
        ? Array.from(element.labels).map((label) => clean(label.textContent)).filter(Boolean).join(" ")
        : "";
      const accessibleLabel = read("aria-label") || labelledBy || associatedLabels;
      const structure = describeStructure(element, link);
      return {
        found: true,
        identity: targetIdentity(element),
        tag: element.tagName.toLowerCase(),
        role: read("role"),
        type: clean("type" in element ? element.type : read("type")),
        name: read("name"),
        id: clean(element.id),
        autocomplete: read("autocomplete"),
        ariaLabel: accessibleLabel,
        placeholder: read("placeholder"),
        inputMode: read("inputmode"),
        title: read("title"),
        value: element.matches("button, input[type='button'], input[type='submit']")
          ? clean(element.value)
          : "",
        text: clean(element.innerText || element.textContent),
        href: link instanceof HTMLAnchorElement ? clean(link.href, 4096) : "",
        // Bind approvals to the actual form owner independently of its label.
        formOwnerIdentity: form ? targetIdentity(form) : "",
        // Keep a non-empty description even for an unlabeled implicit form.
        formActionText,
        disabled: Boolean("disabled" in element && element.disabled) || read("aria-disabled") === "true",
        // A link that sends a request or runs a declared script (Rails UJS,
        // Turbo, htmx, an onclick attribute) is not a plain link.
        linkSelf: link instanceof HTMLAnchorElement && link === element &&
          !["data-method", "data-turbo-method", "data-remote", "data-confirm", "data-turbo-confirm",
            "hx-get", "hx-post", "hx-put", "hx-patch", "hx-delete", "onclick"]
            .some((name) => typeof link.getAttribute === "function" && link.getAttribute(name) !== null),
        download: link instanceof HTMLAnchorElement && typeof link.getAttribute === "function" && link.getAttribute("download") !== null,
        formMethod: form ? clean(form.getAttribute("method") || "get", 16).toLowerCase() : "",
        formActionUrl: form ? clean(typeof form.action === "string" ? form.action : form.getAttribute("action"), 4096) : "",
        formHasPassword,
        formPasswordCount,
        signInIdentifier,
        formFieldCount,
        formSubmitLabels,
        contentEditable: element.isContentEditable === true,
        ...structure,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    };
    const securityFingerprint = (item) => JSON.stringify(Object.fromEntries(
      securityFingerprintFields.map((field) => [
        field,
        field === "disabled" ? item?.[field] === true : item?.[field] ?? "",
      ]),
    ));
    const guardedTarget = () => {
      const element = findTarget();
      const item = descriptor(element);
      const indexedElementAfterInspection = findTarget();
      const targetChanged = indexedElementAfterInspection !== element
        || !item.found
        || !item.identity
        || item.identity !== args.expectedIdentity
        || securityFingerprint(item) !== args.expectedSecurityFingerprint;
      return { element, item, targetChanged };
    };
    ${body}
  })()`;
}

export function personalBrowserTargetExpectation(
  descriptor: PersonalBrowserActivationTarget,
  securityFingerprint: string,
): PersonalBrowserTargetExpectation {
  const identity = descriptor.identity?.trim();
  if (!identity || !securityFingerprint) {
    throw new Error("Personal Browser target expectation is incomplete.");
  }
  return { identity, securityFingerprint };
}

async function executeIsolated<T>(webContents: WebContents, code: string): Promise<T> {
  return (await webContents.executeJavaScriptInIsolatedWorld(
    PERSONAL_BROWSER_ISOLATED_WORLD_ID,
    [{ code }],
    false,
  )) as T;
}

export async function snapshotPersonalBrowserPage(
  webContents: WebContents,
): Promise<PersonalBrowserPageSnapshot> {
  const result = await executeIsolated<Omit<PersonalBrowserPageSnapshot, "capturedAt">>(
    webContents,
    buildPageScript({}, `
      const interactive = candidates().slice(0, 500).map((element, index) => {
        const item = descriptor(element);
        if (!item.found || !item.identity) return null;
        const fallbackName = item.placeholder || item.title || item.type || item.tag;
        return {
          index,
          tag: item.tag,
          ...(item.role ? { role: item.role } : {}),
          ...((item.ariaLabel || item.text || fallbackName) ? { name: item.ariaLabel || item.text || fallbackName } : {}),
          ...(item.type ? { type: item.type } : {}),
          disabled: item.disabled === true,
          identity: item.identity,
          descriptor: item,
        };
      }).filter(Boolean);
      return {
        url: globalThis.location.href,
        title: clean(document.title, 1_000),
        text: clean(document.body?.innerText ?? "", 60_000),
        interactive,
        documentToken: registry.documentToken,
        signals: pageSecretSignals(),
      };
    `),
  );
  return { ...result, capturedAt: new Date().toISOString() };
}

// Only trusted, fixed styling runs here. No input values, page text or supplied
// JavaScript enter the guidance contract. Styling the actual element keeps the
// highlight aligned through scrolling/reflow and disappears if it is replaced.
export async function highlightPersonalBrowserHumanInput(
  webContents: WebContents,
  targets: Array<{ index: number; expectation: PersonalBrowserTargetExpectation }>,
): Promise<boolean> {
  return executeIsolated<boolean>(webContents, buildPageScript({ targets }, `
    const elements = candidates();
    const selected = args.targets.map((target) => {
      const element = elements[target.index];
      const item = element ? descriptor(element) : null;
      if (!item || !item.found || item.disabled ||
          item.identity !== target.expectation.identity ||
          securityFingerprint(item) !== target.expectation.securityFingerprint || candidates()[target.index] !== element ||
          !element.matches("input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='textbox']")) return null;
      return element;
    });
    if (selected.some((element) => !element)) return false;
    for (const previous of registry.humanInputHighlights || []) {
      if (previous.element.style.outline === previous.appliedOutline) previous.element.style.outline = previous.outline;
      if (previous.element.style.outlineOffset === "3px") previous.element.style.outlineOffset = previous.offset;
    }
    registry.humanInputHighlights = selected.map((element) => {
      const previous = { element, outline: element.style.outline, offset: element.style.outlineOffset };
      element.style.outline = "3px solid #f59e0b";
      element.style.outlineOffset = "3px";
      previous.appliedOutline = element.style.outline;
      return previous;
    });
    return true;
  `));
}

export async function clearPersonalBrowserHumanInput(webContents: WebContents): Promise<void> {
  await executeIsolated(webContents, buildPageScript({}, `
    for (const previous of registry.humanInputHighlights || []) {
      if (previous.element.style.outline === previous.appliedOutline) previous.element.style.outline = previous.outline;
      if (previous.element.style.outlineOffset === "3px") previous.element.style.outlineOffset = previous.offset;
    }
    registry.humanInputHighlights = [];
  `));
}

export async function inspectPersonalBrowserTarget(
  webContents: WebContents,
  target: PersonalBrowserTarget,
): Promise<PersonalBrowserTargetDescriptor> {
  return executeIsolated<PersonalBrowserTargetDescriptor>(
    webContents,
    buildPageScript(target, "return descriptor(findTarget());"),
  );
}

export async function clickPersonalBrowserTarget(
  webContents: WebContents,
  target: PersonalBrowserTarget,
  expected: PersonalBrowserTargetExpectation,
): Promise<PersonalBrowserTargetMutationResult & { clicked: boolean }> {
  return executeIsolated(
    webContents,
    buildPageScript(
      {
        ...target,
        expectedIdentity: expected.identity,
        expectedSecurityFingerprint: expected.securityFingerprint,
      },
      `
        const guarded = guardedTarget();
        if (
          guarded.targetChanged ||
          !(guarded.element instanceof HTMLElement) ||
          guarded.item.disabled
        ) {
          return {
            clicked: false,
            targetChanged: guarded.targetChanged,
            descriptor: guarded.item,
          };
        }
        guarded.element.click();
        return { clicked: true, targetChanged: false, descriptor: guarded.item };
      `,
    ),
  );
}

export async function typeIntoPersonalBrowserTarget(
  webContents: WebContents,
  target: PersonalBrowserTarget,
  text: string,
  expected: PersonalBrowserTargetExpectation,
): Promise<
  PersonalBrowserTargetMutationResult & {
    typed: boolean;
    blockedSensitive: boolean;
  }
> {
  return executeIsolated(
    webContents,
    buildPageScript({
      ...target,
      text,
      expectedIdentity: expected.identity,
      expectedSecurityFingerprint: expected.securityFingerprint,
    }, `
      let guarded = guardedTarget();
      if (guarded.targetChanged || !(guarded.element instanceof HTMLElement) || guarded.item.disabled) {
        return {
          typed: false,
          blockedSensitive: false,
          targetChanged: guarded.targetChanged,
          descriptor: guarded.item,
        };
      }
      const element = guarded.element;
      const item = guarded.item;
      const sensitiveText = [
        item.tag, item.type, item.name, item.id, item.autocomplete,
        item.ariaLabel, item.placeholder, item.inputMode
      ].join(" ");
      const sensitive = item.type === "password"
        || /(?:current-password|new-password|one-time-code|cc-(?:number|csc|exp|name))/i.test(item.autocomplete)
        || /(?:\\bpass(?:word|code|phrase)?\\b|\\bpin\\b|\\bone[\\s_-]*time\\b|\\botp\\b|\\b2fa\\b|\\bmfa\\b|\\bverification[\\s_-]*code\\b|\\bsecurity[\\s_-]*code\\b|\\bcvv\\b|\\bcvc\\b|\\bcard[\\s_-]*(?:number|code)\\b|\\bcredit[\\s_-]*card\\b|\\bdebit[\\s_-]*card\\b|\\bpayment\\b)/i.test(sensitiveText);
      if (sensitive) {
        return { typed: false, blockedSensitive: true, targetChanged: false, descriptor: item };
      }

      element.focus();
      guarded = guardedTarget();
      if (guarded.targetChanged || guarded.element !== element) {
        return {
          typed: false,
          blockedSensitive: false,
          targetChanged: true,
          descriptor: guarded.item,
        };
      }
      if (element instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) {
          return { typed: false, blockedSensitive: false, targetChanged: false, descriptor: item };
        }
        setter.call(element, args.text);
      } else if (element instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (!setter) {
          return { typed: false, blockedSensitive: false, targetChanged: false, descriptor: item };
        }
        setter.call(element, args.text);
      } else if (element.isContentEditable) {
        element.textContent = args.text;
      } else {
        return { typed: false, blockedSensitive: false, targetChanged: false, descriptor: item };
      }
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: args.text,
        inputType: "insertText",
      }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { typed: true, blockedSensitive: false, targetChanged: false, descriptor: item };
    `),
  );
}

export async function pressPersonalBrowserTarget(
  webContents: WebContents,
  target: PersonalBrowserTarget,
  key: string,
  expected: PersonalBrowserTargetExpectation,
): Promise<PersonalBrowserTargetMutationResult & { pressed: boolean }> {
  return executeIsolated(
    webContents,
    buildPageScript(
      {
        ...target,
        key,
        expectedIdentity: expected.identity,
        expectedSecurityFingerprint: expected.securityFingerprint,
      },
      `
        let guarded = guardedTarget();
        if (
          guarded.targetChanged ||
          !(guarded.element instanceof HTMLElement) ||
          guarded.item.disabled
        ) {
          return {
            pressed: false,
            targetChanged: guarded.targetChanged,
            descriptor: guarded.item,
          };
        }
        const element = guarded.element;
        element.focus();
        guarded = guardedTarget();
        if (guarded.targetChanged || guarded.element !== element) {
          return { pressed: false, targetChanged: true, descriptor: guarded.item };
        }

        const applyEditableDefault = () => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const value = element.value;
            let start = typeof element.selectionStart === "number" ? element.selectionStart : value.length;
            let end = typeof element.selectionEnd === "number" ? element.selectionEnd : start;
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(args.key)) {
              const next = args.key === "Home"
                ? 0
                : args.key === "End"
                  ? value.length
                  : Math.max(0, Math.min(value.length, start + (args.key === "ArrowLeft" ? -1 : 1)));
              element.setSelectionRange?.(next, next);
              return true;
            }
            let replacement = null;
            let inputType = "insertText";
            if (args.key === "Backspace") {
              if (start === end && start > 0) start -= 1;
              replacement = "";
              inputType = "deleteContentBackward";
            } else if (args.key === "Delete") {
              if (start === end && end < value.length) end += 1;
              replacement = "";
              inputType = "deleteContentForward";
            } else if (args.key === " ") {
              replacement = " ";
            } else if (args.key === "Enter" && element instanceof HTMLTextAreaElement) {
              replacement = "\\n";
              inputType = "insertLineBreak";
            }
            if (replacement === null) return false;
            const nextValue = value.slice(0, start) + replacement + value.slice(end);
            const prototype = element instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (!setter) return false;
            setter.call(element, nextValue);
            const caret = start + replacement.length;
            element.setSelectionRange?.(caret, caret);
            element.dispatchEvent(new InputEvent("input", {
              bubbles: true,
              composed: true,
              data: replacement,
              inputType,
            }));
            return true;
          }
          if (element.isContentEditable && ["Backspace", "Delete", " ", "Enter"].includes(args.key)) {
            const command = args.key === "Backspace"
              ? "delete"
              : args.key === "Delete"
                ? "forwardDelete"
                : "insertText";
            const value = args.key === " " ? " " : args.key === "Enter" ? "\\n" : null;
            document.execCommand(command, false, value);
            return true;
          }
          return false;
        };
        const keyboardOptions = {
          key: args.key,
          code: args.key === " " ? "Space" : args.key,
          bubbles: true,
          cancelable: true,
          composed: true,
        };
        const continueDefault = element.dispatchEvent(new KeyboardEvent("keydown", keyboardOptions));
        if (continueDefault) {
          const tag = guarded.item.tag;
          const role = guarded.item.role;
          const type = guarded.item.type;
          const activationTarget = tag === "button" || tag === "a"
            || role === "button" || role === "link"
            || (tag === "input" && ["button", "submit", "image"].includes(type));
          if (applyEditableDefault()) {
            // The equivalent trusted browser default is applied in this same
            // guarded renderer turn; native input is deliberately not queued.
          } else if ((args.key === "Enter" || args.key === " ") && activationTarget) {
            element.click();
          } else if (args.key === "Enter" && element.form instanceof HTMLFormElement) {
            element.form.requestSubmit();
          } else if (args.key === "Escape") {
            element.blur();
          } else if (args.key === "Tab") {
            const all = candidates();
            const currentIndex = all.indexOf(element);
            const next = all[(currentIndex + 1) % all.length];
            if (next instanceof HTMLElement) next.focus();
          } else if (args.key === "PageUp" || args.key === "PageDown") {
            globalThis.scrollBy({
              top: (args.key === "PageUp" ? -1 : 1) * Math.max(1, globalThis.innerHeight - 40),
              left: 0,
              behavior: "instant",
            });
          }
        }
        element.dispatchEvent(new KeyboardEvent("keyup", keyboardOptions));
        return { pressed: true, targetChanged: false, descriptor: guarded.item };
      `,
    ),
  );
}

export async function focusPersonalBrowserTarget(
  webContents: WebContents,
  target: PersonalBrowserTarget,
): Promise<PersonalBrowserTargetDescriptor> {
  return executeIsolated(
    webContents,
    buildPageScript(target, `
      const element = findTarget();
      if (element instanceof HTMLElement) element.focus();
      return descriptor(element);
    `),
  );
}

export async function scrollPersonalBrowserPage(
  webContents: WebContents,
  amount: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return executeIsolated(
    webContents,
    buildPageScript(amount, `
      globalThis.scrollBy({ left: args.x, top: args.y, behavior: "instant" });
      return { x: Math.round(globalThis.scrollX), y: Math.round(globalThis.scrollY) };
    `),
  );
}
