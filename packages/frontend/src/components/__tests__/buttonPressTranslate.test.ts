import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The shared Button presses in with `data-[pressed]:translate-y-px`. Tailwind
// v4 translate utilities all write one --tw-translate-x/--tw-translate-y pair
// behind the CSS `translate` property, so a Button centred with
// `top-1/2 -translate-y-1/2` swaps its -50% for 1px while pressed and drops by
// half its height until release. Centre these controls with auto margins
// (`inset-y-0 my-auto`) or an absolutely positioned flex wrapper instead. A
// `data-[pressed]:` translate stays allowed: that is how a row opts out of the
// nudge, and it cannot move the control at rest.

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, "../../..");
const src = resolve(frontend, "src");

const BUTTON_TAGS = new Set(["Button", "IconButton", "ToggleIconButton"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__tests__" ? [] : sourceFiles(path);
      }
      return entry.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(entry.name) ? [path] : [];
    });
}

// Splits `dark:data-[pressed]:!-translate-y-1/2` into its variants and the
// utility, ignoring colons inside arbitrary values such as `[&:hover]`.
function splitVariants(token: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === ":" && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  const utility = token.slice(start).replace(/^!|!$/g, "").replace(/^-/, "");
  return { variants: parts, utility };
}

function isRestTranslate(token: string) {
  const { variants, utility } = splitVariants(token);
  if (variants.includes("data-[pressed]")) return false;
  return /^translate(-|$)/.test(utility) || utility.startsWith("[translate:");
}

// Every string literal inside the className expression, plus the initializer
// of a same-file string constant it names. Class names always arrive as whole
// literals for Tailwind to see them, so this covers cn() calls, ternaries,
// template strings and joined arrays alike.
function classStrings(expression: ts.Node, constants: Map<string, ts.Expression>) {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      found.push(node.text);
      return;
    }
    if (ts.isIdentifier(node)) {
      const initializer = constants.get(node.text);
      if (initializer && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        visit(initializer);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function findTranslatedButtons(source: string, label: string) {
  const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = new Map<string, ts.Expression>();
  const offenders: string[] = [];
  let buttons = 0;

  const collectConstants = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteralLike(node.initializer) || ts.isTemplateExpression(node.initializer))
    ) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectConstants);
  };
  collectConstants(file);

  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && BUTTON_TAGS.has(node.tagName.getText(file))) {
      buttons += 1;
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText(file) !== "className" || !attribute.initializer) {
          continue;
        }
        const tokens = classStrings(attribute.initializer, constants).flatMap((text) => text.split(/\s+/));
        const translated = tokens.filter(isRestTranslate);
        if (translated.length > 0) {
          const line = file.getLineAndCharacterOfPosition(attribute.getStart(file)).line + 1;
          offenders.push(`${label}:${line} <${node.tagName.getText(file)}> ${translated.join(" ")}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { buttons, offenders };
}

describe("shared Button placement", () => {
  it("flags a translate-centred button and allows a pressed-state opt-out", () => {
    const centred = findTranslatedButtons(
      `const EYE = "absolute top-1/2 -translate-y-1/2";
       export const A = () => <>
         <ToggleIconButton isSelected className="absolute right-2 top-1/2 -translate-y-1/2" />
         <IconButton className={cn("absolute", open ? "left-1/2 -translate-x-1/2" : "")}>x</IconButton>
         <Button className={EYE}>y</Button>
       </>;`,
      "fixture.tsx",
    );
    expect(centred.offenders).toEqual([
      "fixture.tsx:3 <ToggleIconButton> -translate-y-1/2",
      "fixture.tsx:4 <IconButton> -translate-x-1/2",
      "fixture.tsx:5 <Button> -translate-y-1/2",
    ]);

    const optOut = findTranslatedButtons(
      `export const B = () => (
         <Button className="absolute inset-y-0 right-2 my-auto data-[pressed]:!translate-y-0 data-[pressed]:!scale-100">z</Button>
       );`,
      "fixture.tsx",
    );
    expect(optOut).toEqual({ buttons: 1, offenders: [] });
  });

  it("never positions a Button, IconButton or ToggleIconButton with a translate utility", () => {
    const files = sourceFiles(src);
    let buttons = 0;
    const offenders = files.flatMap((path) => {
      const result = findTranslatedButtons(readFileSync(path, "utf8"), relative(frontend, path));
      buttons += result.buttons;
      return result.offenders;
    });

    // Guards against the walk silently finding nothing.
    expect(files.length).toBeGreaterThan(100);
    expect(buttons).toBeGreaterThan(100);
    expect(
      offenders,
      "The shared Button's press nudge is a translate and replaces any translate the caller sets, " +
        "so a translate-centred button jumps while pressed. Centre it with `inset-y-0 my-auto` " +
        "(or `inset-x-0 mx-auto`) or an absolutely positioned flex wrapper instead.",
    ).toEqual([]);
  });
});
