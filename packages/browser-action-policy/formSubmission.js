"use strict";

/*
 * The form submission a browser step makes, shared by the Desktop Personal
 * Browser and the hosted Shared Browser, so both judge the same submission
 * the browser will send.
 *
 * formSubmissionRulesInPage() runs inside the page. It uses nothing from this
 * file's scope, so a host sends its source into the page (Shared) or into an
 * isolated world (Personal). It returns:
 *
 *   submissionOf(element, fallbackForm)
 *     What the step that submits through `element` sends:
 *     - a submit button, a child of one, or a label of one: clicking it (and
 *       Enter or Space on the button) submits with that button as the
 *       submitter (via "button");
 *     - another control of a form (a field, checkbox, radio, select): Enter
 *       submits implicitly, through the form's default button (via
 *       "implicit");
 *     - any other element of a form, or `fallbackForm` when it has none:
 *       nothing; the result then describes the form's own submission
 *       (via "").
 *     { form, via, submits, action, method, enctype, target, newWindow }, or
 *     null when there is no form. `submits` is false when the browser sends
 *     nothing: a disabled submitter, or an implicit submission that is
 *     blocked. The other fields then still describe the submission the
 *     blocked button would make, because the page can enable it.
 *   implicitSubmission(element)
 *     For a host that performs Enter itself: { form, button, blocked }, the
 *     button Enter clicks (null: the form submits itself), or null when Enter
 *     in `element` starts no implicit submission.
 *   keyActivatedButton(element)
 *     The button that Enter or Space on `element` clicks: the element or a
 *     <button> around it. Null for any other element.
 *
 * The rules, from the HTML form submission and implicit submission
 * algorithms, as Chromium runs them:
 * - The submitter's formaction, formmethod, formenctype and formtarget
 *   attributes replace the form's action, method, enctype and target. One
 *   that is present but empty still replaces it.
 * - An empty action is the document's own address; any other is resolved
 *   against the document's base URL, so <base href> applies. An unknown
 *   method is GET; an unknown enctype is application/x-www-form-urlencoded.
 * - Without a target, the first <base target> applies. "_blank", or a name
 *   that is neither this window's nor a frame's on the page, opens another
 *   window. "_self", "_parent" and "_top" stay in the tab.
 * - method="dialog" closes a dialog and sends nothing.
 * - Enter in a text field (text, search, email, url, tel, password, number)
 *   clicks the form's default button: its first submit button in tree order,
 *   including one outside the form that joins it with form=. A disabled
 *   default button blocks the submission.
 * - Enter in another control (checkbox, radio, date, range, select) clicks
 *   the first submit button that is not disabled. Chromium does this; the
 *   standard would block on a disabled default button.
 * - With no submit button, Enter in a text field submits the form itself when
 *   it is the form's only text field. Chromium counts text fields only, so a
 *   date or time field does not block it.
 *
 * Plain script with no imports. In CommonJS it exports its API; evaluated
 * where `module` is undefined it sets `globalThis.__instafyBrowserFormSubmission`.
 */
(function defineBrowserFormSubmission(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.__instafyBrowserFormSubmission = api;
  }
})(typeof globalThis === "object" ? globalThis : null, function browserFormSubmissionFactory() {
  // Runs inside the page. Form and document properties are read through the
  // DOM prototypes: a control named "action", "method" or "target", or an
  // element named "URL" or "querySelectorAll", shadows them on the instance.
  function formSubmissionRulesInPage() {
    const MAX_URL_CHARS = 4_096;
    const MAX_SCANNED = 20_000;
    const accessor = (prototype, name) => {
      for (let current = prototype; current; current = Object.getPrototypeOf(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) return descriptor.get || descriptor.value;
      }
      return null;
    };
    const getAttribute = accessor(Element.prototype, "getAttribute");
    const hasAttribute = accessor(Element.prototype, "hasAttribute");
    const matches = accessor(Element.prototype, "matches");
    const localNameOf = accessor(Element.prototype, "localName");
    const parentOf = accessor(Node.prototype, "parentElement");
    const ownerDocumentOf = accessor(Node.prototype, "ownerDocument");
    const rootOf = accessor(Node.prototype, "getRootNode");
    const nodeTypeOf = accessor(Node.prototype, "nodeType");
    const baseUrlOf = accessor(Node.prototype, "baseURI");
    const documentUrlOf = accessor(Document.prototype, "URL");
    const documentQueryAll = accessor(Document.prototype, "querySelectorAll");
    const documentQuery = accessor(Document.prototype, "querySelector");
    const fragmentQueryAll = accessor(DocumentFragment.prototype, "querySelectorAll");
    const defaultViewOf = accessor(Document.prototype, "defaultView");

    const attribute = (element, name) => getAttribute.call(element, name);
    const has = (element, name) => hasAttribute.call(element, name);
    const tag = (element) => {
      try {
        return String(localNameOf.call(element) || "");
      } catch (_) {
        return "";
      }
    };
    const lower = (value) => String(value || "").replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const bounded = (value) => String(value || "").slice(0, MAX_URL_CHARS);
    const disabled = (element) => {
      try {
        return matches.call(element, ":disabled");
      } catch (_) {
        return true;
      }
    };
    const typeOf = (element) => lower(element.type);

    const isSubmitButton = (element) => {
      const name = tag(element);
      return (name === "button" && typeOf(element) === "submit") ||
        (name === "input" && (typeOf(element) === "submit" || typeOf(element) === "image"));
    };
    // The form a listed control belongs to: its form= form, its enclosing
    // form, or none.
    const formOwnerOf = (element) => {
      const name = tag(element);
      if (!["button", "input", "select", "textarea", "fieldset", "object", "output"].includes(name)) return null;
      const form = element.form;
      return form && tag(form) === "form" ? form : null;
    };
    // Chromium's text fields: Enter in one is an implicit submission trigger.
    const TEXT_FIELD_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
    const isTextField = (element) => tag(element) === "input" && TEXT_FIELD_TYPES.has(typeOf(element));
    // Controls in which Enter starts an implicit submission at all. Buttons
    // are clicked instead; a textarea takes a line break; a color or file
    // input opens its chooser.
    const NO_IMPLICIT_TYPES = new Set(["submit", "image", "reset", "button", "hidden", "file", "color"]);
    const startsImplicitSubmission = (element) =>
      (tag(element) === "input" && !NO_IMPLICIT_TYPES.has(typeOf(element))) || tag(element) === "select";

    // The form's controls of one kind, in tree order: those inside it and
    // those that join it with form= from elsewhere in the same tree.
    const controlsOf = (form, selector, keep) => {
      const root = rootOf.call(form);
      let all;
      try {
        // 9 is DOCUMENT_NODE; a form in a shadow tree has its shadow root.
        all = nodeTypeOf.call(root) === 9 ? documentQueryAll.call(root, selector) : fragmentQueryAll.call(root, selector);
      } catch (_) {
        all = [];
      }
      const found = [];
      for (let index = 0; index < all.length && index < MAX_SCANNED; index += 1) {
        const control = all[index];
        if (formOwnerOf(control) === form && keep(control)) found.push(control);
      }
      return found;
    };
    const submitButtonsOf = (form) => controlsOf(form, "button, input", isSubmitButton);

    const resolve = (element, value) => {
      if (value === "") return bounded(documentUrlOf.call(ownerDocumentOf.call(element)));
      try {
        return bounded(new URL(value, baseUrlOf.call(element)).href);
      } catch (_) {
        // The browser sends nothing to an address it cannot parse; keeping
        // the raw value makes it no site at all, never the page's own.
        return bounded(value);
      }
    };
    const METHODS = new Set(["get", "post", "dialog"]);
    const ENCTYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
    const method = (value) => (METHODS.has(lower(value)) ? lower(value) : "get");
    const enctype = (value) => (ENCTYPES.has(lower(value)) ? lower(value) : "application/x-www-form-urlencoded");

    // Whether a target name leaves the tab: "_blank", or a name that is
    // neither this window's nor that of a frame on the page.
    const opensNewWindow = (form, target) => {
      const keyword = lower(target);
      if (keyword === "" || keyword === "_self" || keyword === "_parent" || keyword === "_top") return false;
      if (keyword === "_blank") return true;
      const doc = ownerDocumentOf.call(form);
      try {
        if (defaultViewOf.call(doc).name === target) return false;
      } catch (_) {
        // An unknown window name is not this window's.
      }
      const frames = documentQueryAll.call(doc, "iframe, frame, object");
      for (let index = 0; index < frames.length && index < MAX_SCANNED; index += 1) {
        const frame = frames[index];
        if (attribute(frame, "name") === target) return false;
        try {
          if (frame.contentWindow && frame.contentWindow.name === target) return false;
        } catch (_) {
          // Another site's frame keeps its name to itself.
        }
      }
      return true;
    };
    const targetOf = (form, submitter) => {
      let target;
      if (submitter && has(submitter, "formtarget")) {
        target = attribute(submitter, "formtarget");
      } else if (has(form, "target")) {
        target = attribute(form, "target");
      } else {
        const base = documentQuery.call(ownerDocumentOf.call(form), "base[target]");
        target = base ? attribute(base, "target") : "";
      }
      target = String(target || "");
      // A name with a line break and "<" is dangling markup: HTML opens a new window.
      if (/[\t\n\r]/.test(target) && target.includes("<")) target = "_blank";
      return target;
    };

    // What `submitter` (a submit button, or null for the form itself) sends.
    const describe = (form, submitter, via, submits) => {
      const override = (name) => Boolean(submitter) && has(submitter, name);
      const actionValue = override("formaction") ? attribute(submitter, "formaction") : has(form, "action") ? attribute(form, "action") : "";
      const target = targetOf(form, submitter);
      const sent = method(override("formmethod") ? attribute(submitter, "formmethod") : attribute(form, "method"));
      return {
        form,
        via,
        submits,
        action: resolve(submitter || form, String(actionValue || "")),
        method: sent,
        enctype: enctype(override("formenctype") ? attribute(submitter, "formenctype") : attribute(form, "enctype")),
        target: bounded(target),
        // A dialog submission closes the dialog and opens nothing.
        newWindow: sent !== "dialog" && opensNewWindow(form, target),
      };
    };

    // The element a click on `element` activates: the element itself, or
    // the nearest button, input, link or summary around it. A label
    // activates its control.
    const activatedBy = (element) => {
      let node = element;
      for (let depth = 0; node && depth < 64; depth += 1, node = parentOf.call(node)) {
        const name = tag(node);
        if (["button", "input", "select", "textarea", "summary"].includes(name)) return node;
        if ((name === "a" || name === "area") && has(node, "href")) return node;
        if (name === "label") return node.control || null;
      }
      return null;
    };

    function keyActivatedButton(element) {
      const name = tag(element);
      if (name === "input") return ["submit", "image", "reset", "button"].includes(typeOf(element)) ? element : null;
      let node = element;
      for (let depth = 0; node && depth < 64; depth += 1, node = parentOf.call(node)) {
        const current = tag(node);
        if (current === "button") return node;
        if (["input", "select", "textarea", "summary"].includes(current)) return null;
        if ((current === "a" || current === "area") && has(node, "href")) return null;
      }
      return null;
    }

    function implicitSubmission(element) {
      if (!startsImplicitSubmission(element)) return null;
      const form = formOwnerOf(element);
      if (!form) return null;
      const buttons = submitButtonsOf(form);
      if (buttons.length > 0) {
        const defaultButton = buttons[0];
        if (isTextField(element)) return { form, button: defaultButton, blocked: disabled(defaultButton) };
        const enabled = buttons.find((button) => !disabled(button));
        return enabled ? { form, button: enabled, blocked: false } : { form, button: defaultButton, blocked: true };
      }
      if (!isTextField(element)) return { form, button: null, blocked: true };
      return { form, button: null, blocked: controlsOf(form, "input", isTextField).length > 1 };
    }

    function submissionOf(element, fallbackForm) {
      const activated = activatedBy(element);
      if (activated && isSubmitButton(activated)) {
        const form = formOwnerOf(activated);
        if (form) return describe(form, activated, "button", !disabled(activated));
      }
      const implicit = implicitSubmission(element);
      if (implicit) return describe(implicit.form, implicit.button, "implicit", !implicit.blocked);
      const form = formOwnerOf(element) || (fallbackForm && tag(fallbackForm) === "form" ? fallbackForm : null);
      return form ? describe(form, null, "", false) : null;
    }

    return { submissionOf, implicitSubmission, keyActivatedButton };
  }

  const lower = (value) => String(value || "").toLowerCase();

  // How the step through an element submits, as the page reported it. A
  // describer that did not report it (formSubmission missing) is judged by
  // the control itself: a submit button submits with a click, Enter in an
  // input submits implicitly.
  function submissionKind(facts) {
    if (typeof facts.formSubmission === "string") return facts.formSubmission;
    const tag = lower(facts.tag);
    const type = lower(facts.type);
    if ((tag === "button" && (type === "submit" || type === "")) || (tag === "input" && (type === "submit" || type === "image"))) {
      return "button";
    }
    return tag === "input" && !["button", "reset", "file", "hidden", "color"].includes(type) ? "implicit" : "";
  }

  /**
   * The submission a step makes, from an element's reported facts (the step
   * classifier's field names): `{ action, method, newWindow }`, or null when
   * the step submits no form. A click, Enter or Space on a submit button
   * submits with it; Enter in a form's control submits implicitly; typing
   * with submit counts as a submission of the field's form whatever the
   * field, since the page's script may send it. A dialog submission sends
   * nothing and opens nothing, so it has no action.
   */
  function stepSubmission(facts, step, key) {
    if (!facts || typeof facts !== "object" || !String(facts.formOwnerIdentity || "").trim()) return null;
    const via = submissionKind(facts);
    const pressed = step === "press" ? String(key || "") : "";
    const submits = step === "submit" ||
      (via === "button" && (step === "click" || pressed === "Enter" || pressed === " " || pressed === "Space")) ||
      (via === "implicit" && pressed === "Enter");
    if (!submits) return null;
    const method = lower(facts.formMethod);
    if (method === "dialog") return { action: null, method, newWindow: false };
    return {
      action: typeof facts.formActionUrl === "string" && facts.formActionUrl.trim() ? facts.formActionUrl.trim() : null,
      method: method || "get",
      newWindow: facts.formNewWindow === true,
    };
  }

  return Object.freeze({ formSubmissionRulesInPage, stepSubmission });
});
