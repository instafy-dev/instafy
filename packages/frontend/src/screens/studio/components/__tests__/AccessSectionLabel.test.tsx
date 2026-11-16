import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { textTones } from "../../../../styles/typography";
import { AccessSectionLabel } from "../AccessDecisionCard";

// The label's grey comes from its tone alone. A grey in its own class list
// fought the tone (Tailwind orders utilities that set the same property by
// name), so slate-500 painted in both themes: 3.1:1 on the card in light.
describe("AccessSectionLabel", () => {
  it("reads in the muted grey and carries no other text colour", () => {
    const markup = renderToStaticMarkup(<AccessSectionLabel>Access requested</AccessSectionLabel>);
    const classes = (/class="([^"]*)"/.exec(markup)?.[1] ?? "").split(/\s+/);
    expect(classes.filter((name) => /^(?:dark:)?text-slate-/.test(name))).toEqual(textTones.muted.split(" "));
  });
});
