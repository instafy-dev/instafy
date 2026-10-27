/** How the step through an element submits a form. */
export type FormSubmissionVia =
  /** A click on a submit button, a child of one or its label, or Enter or Space on the button. */
  | "button"
  /** Enter in a field or other control of the form (implicit submission). */
  | "implicit"
  /**
   * Both: a field inside a submit button (or a label of one inside another)
   * submits through that button when clicked and implicitly on Enter, which
   * can send something else. The facts are the click's; hosts refuse its
   * steps that submit.
   */
  | "nested"
  /** The element's step submits nothing; the facts are the form's own. */
  | "";

/** The submission formSubmissionRulesInPage reports, without the form element. */
export type FormSubmissionFacts = {
  via: FormSubmissionVia;
  /** False when the browser sends nothing: a disabled submitter, or a blocked implicit submission. */
  submits: boolean;
  /** The absolute address, after formaction and <base href>; the raw value when it cannot be parsed. */
  action: string;
  method: "get" | "post" | "dialog";
  enctype: "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain";
  /** The target as written (formtarget, the form's target or <base target>); "" for none. */
  target: string;
  /** The submission opens another window: "_blank", or a name that is neither this window's nor a frame's. */
  newWindow: boolean;
};

/** The rules object formSubmissionRulesInPage returns inside a page. */
export type FormSubmissionRules = {
  submissionOf(element: Element, fallbackForm?: HTMLFormElement | null): (FormSubmissionFacts & { form: HTMLFormElement }) | null;
  implicitSubmission(element: Element): { form: HTMLFormElement; button: HTMLElement | null; blocked: boolean } | null;
  keyActivatedButton(element: Element): HTMLElement | null;
};

/**
 * Runs inside a page or an isolated world, where its source is sent with
 * Function.prototype.toString; it uses nothing from this module's scope.
 */
export declare function formSubmissionRulesInPage(): FormSubmissionRules;

/** Facts a host reports for an element, under the step classifier's field names. */
export type FormSubmissionTargetFacts = {
  tag?: string | null;
  type?: string | null;
  /** Empty when the element belongs to no form. */
  formOwnerIdentity?: string | null;
  /** Missing (null) when the describer did not report it: then judged by tag and type. */
  formSubmission?: string | null;
  formMethod?: string | null;
  formActionUrl?: string | null;
  formNewWindow?: boolean;
};

/**
 * The submission a step makes: the address (null for a dialog, which sends
 * nothing), the method, whether it opens another window and whether the
 * control submits two ways (`nested`, which hosts refuse). Null when the step
 * submits no form.
 */
export declare function stepSubmission(
  facts: FormSubmissionTargetFacts,
  step: "click" | "press" | "submit",
  key?: string,
): { action: string | null; method: string; newWindow: boolean; nested: boolean } | null;
