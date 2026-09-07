import type { WebContents } from "electron";

import {
  PERSONAL_BROWSER_SECURITY_FINGERPRINT_FIELDS,
  type PersonalBrowserActivationTarget,
  type PersonalBrowserActionDescriptor,
  type PersonalBrowserEditableDescriptor,
} from "./personalBrowserSecurity";

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

export type PersonalBrowserPageSnapshot = {
  url: string;
  title: string;
  text: string;
  interactive: PersonalBrowserInteractiveElement[];
  documentToken: string;
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

function buildPageScript(argumentsValue: unknown, body: string): string {
  return `(() => {
    "use strict";
    const args = ${serializeForScript(argumentsValue)};
    const securityFingerprintFields = ${serializeForScript(PERSONAL_BROWSER_SECURITY_FINGERPRINT_FIELDS)};
    const interactiveSelector = [
      "a[href]", "button", "input:not([type='hidden'])", "textarea", "select",
      "[contenteditable='true']", "[role='button']", "[role='link']", "[role='textbox']",
      "[tabindex]:not([tabindex='-1'])"
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
      const submit = form ? Array.from(form.elements).find((control) =>
        control.form === form && (
          (control instanceof HTMLButtonElement && control.type === "submit") ||
          (control instanceof HTMLInputElement && ["submit", "image"].includes(control.type))
        ),
      ) : null;
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
