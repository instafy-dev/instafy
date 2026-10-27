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
 *     - an element whose click reaches a submit button (the button, anything
 *       inside it, a label of it): clicking it (and Enter or Space on a
 *       button) submits with that button as the submitter (via "button");
 *     - another control of a form (a field, checkbox, radio, select): Enter
 *       submits implicitly, through the form's default button (via
 *       "implicit");
 *     - a control of both kinds, such as a field inside a submit button: a
 *       click submits through that button and Enter through the default
 *       button, which can send something else (via "nested"). The other
 *       fields describe the click's; hosts take neither step;
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
 * - A click travels up its event path (through the slot an element is
 *   assigned to and from a shadow root to its host) until an element takes
 *   it. A link, a checkbox or radio, a file or colour chooser, a reset button
 *   and a details summary take it and submit nothing; a submit button of a
 *   form takes it and submits. Every other element passes it on: text
 *   fields, selects, text areas, plain buttons, and labels, which click
 *   their control as well.
 * - The submitter's formaction, formmethod, formenctype and formtarget
 *   attributes replace the form's action, method, enctype and target. One
 *   that is present but empty still replaces it.
 * - An action that is empty, or only spaces, is the document's own address;
 *   any other is resolved against the document's base URL, so <base href>
 *   applies. An unknown method is GET; an unknown enctype is
 *   application/x-www-form-urlencoded.
 * - An empty or missing target takes the first <base target>. "_blank", or a
 *   name that is neither this window's nor a frame's on the page, opens
 *   another window. "_self", "_parent" and "_top" stay in the tab.
 * - method="dialog" closes a dialog and sends nothing.
 * - Enter in a text field (text, search, email, url, tel, password, number)
 *   clicks the form's default button: its first submit button in tree order,
 *   including one outside the form that joins it with form=, however many
 *   controls the page has. A disabled default button blocks the submission.
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
    const assignedSlotOf = accessor(Element.prototype, "assignedSlot");
    const firstElementChildOf = accessor(Element.prototype, "firstElementChild");
    const nextElementSiblingOf = accessor(Element.prototype, "nextElementSibling");
    const parentNodeOf = accessor(Node.prototype, "parentNode");
    const ownerDocumentOf = accessor(Node.prototype, "ownerDocument");
    const rootOf = accessor(Node.prototype, "getRootNode");
    const nodeTypeOf = accessor(Node.prototype, "nodeType");
    const comparePosition = accessor(Node.prototype, "compareDocumentPosition");
    const baseUrlOf = accessor(Node.prototype, "baseURI");
    const documentUrlOf = accessor(Document.prototype, "URL");
    const documentQueryAll = accessor(Document.prototype, "querySelectorAll");
    const documentQuery = accessor(Document.prototype, "querySelector");
    const fragmentQueryAll = accessor(DocumentFragment.prototype, "querySelectorAll");
    const defaultViewOf = accessor(Document.prototype, "defaultView");
    const formElementsOf = accessor(HTMLFormElement.prototype, "elements");
    const labelControlOf = accessor(HTMLLabelElement.prototype, "control");
    const shadowHostOf = typeof ShadowRoot === "function" ? accessor(ShadowRoot.prototype, "host") : null;

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

    // The form's listed controls in tree order, those that join it with
    // form= from elsewhere in its tree included: form.elements, whatever else
    // the page holds. It leaves out image buttons, which are looked up in the
    // form's tree and put back in their place.
    const listedControlsOf = (form) => {
      const listed = [];
      try {
        const elements = formElementsOf.call(form);
        for (let index = 0; index < elements.length; index += 1) listed.push(elements[index]);
      } catch (_) {
        // Not a form.
      }
      let images = [];
      try {
        const root = rootOf.call(form);
        const selector = "input[type=image i]";
        // 9 is DOCUMENT_NODE; a form in a shadow tree has its shadow root.
        images = nodeTypeOf.call(root) === 9 ? documentQueryAll.call(root, selector) : fragmentQueryAll.call(root, selector);
      } catch (_) {
        images = [];
      }
      const added = [];
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        if (formOwnerOf(image) === form && !listed.includes(image)) added.push(image);
      }
      if (added.length === 0) return listed;
      // 4 is DOCUMENT_POSITION_FOLLOWING: b comes after a.
      return listed.concat(added).sort((a, b) => (a === b ? 0 : comparePosition.call(a, b) & 4 ? -1 : 1));
    };
    const submitButtonsOf = (form) => listedControlsOf(form).filter(isSubmitButton);

    const resolve = (element, raw) => {
      // Chromium strips HTML spaces from an action first.
      const value = raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
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
      // A name no frame among the first MAX_SCANNED has counts as a window.
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
      let target = submitter && has(submitter, "formtarget")
        ? attribute(submitter, "formtarget")
        : attribute(form, "target");
      // Chromium takes <base target> for an empty target as for a missing one.
      if (!target) {
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

    // The next node of an event's path: the slot an element is assigned to,
    // its parent, or a shadow root's host. A closed shadow tree keeps its
    // slots to itself.
    const nextOnPath = (node) => {
      try {
        const slot = assignedSlotOf.call(node);
        if (slot) return slot;
      } catch (_) {
        // Not an element.
      }
      const parent = parentNodeOf.call(node);
      if (!parent) return null;
      const type = nodeTypeOf.call(parent);
      if (type === 1) return parent;
      // 11 is DOCUMENT_FRAGMENT_NODE: a shadow root, or a fragment.
      if (type !== 11 || !shadowHostOf) return null;
      try {
        return shadowHostOf.call(parent);
      } catch (_) {
        return null;
      }
    };
    const labelControl = (label) => {
      try {
        return labelControlOf.call(label);
      } catch (_) {
        return null;
      }
    };
    // A details element's first summary toggles it; another summary is text.
    const isMainSummary = (summary) => {
      const details = parentNodeOf.call(summary);
      if (!details || nodeTypeOf.call(details) !== 1 || tag(details) !== "details") return false;
      for (let child = firstElementChildOf.call(details); child; child = nextElementSiblingOf.call(child)) {
        if (tag(child) === "summary") return child === summary;
      }
      return false;
    };
    const TAKES_CLICK_INPUT_TYPES = new Set(["checkbox", "radio", "file", "color"]);

    // The submit buttons a click on `element` submits with, as Chromium
    // dispatches it: up the event path to the element that takes the click.
    // A label passes the click on and clicks its control too, so a label of
    // a submit button inside another one finds both. A disabled submit button
    // inside another passes the click on; one that is `element` itself is
    // still the step's submitter, which the page may enable.
    const clickedSubmitButtons = (element) => {
      const found = [];
      for (let node = element; node; node = nextOnPath(node)) {
        const name = tag(node);
        if ((name === "a" || name === "area") && has(node, "href")) break;
        if (name === "summary" && isMainSummary(node)) break;
        if (name === "label") {
          const control = labelControl(node);
          if (control && isSubmitButton(control) && formOwnerOf(control) && !found.includes(control)) found.push(control);
          continue;
        }
        if (name !== "input" && name !== "button") continue;
        const type = typeOf(node);
        if (name === "input" && TAKES_CLICK_INPUT_TYPES.has(type)) break;
        const owned = Boolean(formOwnerOf(node));
        if (type === "reset" && owned && !disabled(node)) break;
        if (isSubmitButton(node) && owned && (node === element || !disabled(node))) {
          if (!found.includes(node)) found.push(node);
          break;
        }
      }
      return found;
    };

    // The button that Enter or Space on `element` clicks: the element, or a
    // <button> its key event reaches first. A field, a link or a summary on
    // the way handles the key itself.
    function keyActivatedButton(element) {
      const name = tag(element);
      if (name === "input") return ["submit", "image", "reset", "button"].includes(typeOf(element)) ? element : null;
      for (let node = element; node; node = nextOnPath(node)) {
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
      return { form, button: null, blocked: listedControlsOf(form).filter(isTextField).length > 1 };
    }

    function submissionOf(element, fallbackForm) {
      const buttons = clickedSubmitButtons(element);
      const implicit = implicitSubmission(element);
      if (buttons.length > 0) {
        const clicked = describe(formOwnerOf(buttons[0]), buttons[0], "button", !disabled(buttons[0]));
        // A field inside a submit button, or a label of one inside another,
        // submits two ways.
        return implicit || buttons.length > 1 ? { ...clicked, via: "nested" } : clicked;
      }
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
   * classifier's field names): `{ action, method, newWindow, nested }`, or
   * null when the step submits no form. A click, Enter or Space on a submit
   * button submits with it; Enter in a form's control submits implicitly;
   * typing with submit counts as a submission of the field's form whatever
   * the field, since the page's script may send it. A dialog submission
   * sends nothing and opens nothing, so it has no action. `nested` marks a
   * control that submits two ways (a field inside a submit button): a host
   * takes none of its steps that submit.
   */
  function stepSubmission(facts, step, key) {
    if (!facts || typeof facts !== "object" || !String(facts.formOwnerIdentity || "").trim()) return null;
    const via = submissionKind(facts);
    const nested = via === "nested";
    const pressed = step === "press" ? String(key || "") : "";
    const submits = step === "submit" ||
      ((via === "button" || nested) && (step === "click" || pressed === "Enter" || pressed === " " || pressed === "Space")) ||
      (via === "implicit" && pressed === "Enter");
    if (!submits) return null;
    const method = lower(facts.formMethod);
    if (method === "dialog") return { action: null, method, newWindow: false, nested };
    return {
      action: typeof facts.formActionUrl === "string" && facts.formActionUrl.trim() ? facts.formActionUrl.trim() : null,
      method: method || "get",
      newWindow: facts.formNewWindow === true,
      nested,
    };
  }

  return Object.freeze({ formSubmissionRulesInPage, stepSubmission });
});
