// The step classifier is shared with the hosted Shared Browser, which embeds
// the same plain script. Desktop bundles it from the workspace package.
export * from "@instafy/browser-action-policy/actionPolicy";
// What a form step submits, computed in the page the way the browser does;
// the Shared Browser embeds the same plain script.
export { formSubmissionRulesInPage, stepSubmission } from "@instafy/browser-action-policy/formSubmission";
