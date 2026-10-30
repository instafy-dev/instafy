import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

// What a prompt says a form step sends (@instafy/browser-action-policy's
// sentFieldNames, which the Shared Browser runs in the page before it asks):
// the fields the submission sends something from, by the names the page
// gives them, and never a value. A submit prompt that only named its button
// left the person to guess what would leave the page.
const require = createRequire(import.meta.url);
const formSubmission = require("@instafy/browser-action-policy/formSubmission");

function page(body) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, {
    url: "https://shop.test/case",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  return dom.window;
}

function sentFieldNames(window, id, typed = false) {
  const rules = window.eval(`(${formSubmission.formSubmissionRulesInPage.toString()})()`);
  // An array of the page's realm, copied into this one.
  return [...rules.sentFieldNames(window.document.getElementById(id), typed)];
}

// A pizza order form, filled the way a person (or Octo) leaves it before the
// submit: some fields typed, a size chosen, no topping ticked, the delivery
// time left empty.
const ORDER_FORM = `
  <form method="post" action="/post">
    <input type="hidden" name="csrf" value="token-value-123">
    <p><label>Customer name: <input name="custname" value="Alex Example"></label></p>
    <p><label>Telephone: <input type="tel" name="custtel" value="555-0107"></label></p>
    <p><label>E-mail address: <input type="email" name="custemail" value="alex@example.com"></label></p>
    <fieldset>
      <legend> Pizza Size </legend>
      <p><label><input type="radio" name="size" value="small"> Small </label></p>
      <p><label><input type="radio" name="size" value="medium" checked> Medium </label></p>
    </fieldset>
    <fieldset>
      <legend> Pizza Toppings </legend>
      <p><label><input type="checkbox" name="topping" value="bacon"> Bacon </label></p>
      <p><label><input type="checkbox" name="topping" value="onion" checked> Onion </label></p>
    </fieldset>
    <fieldset>
      <legend> Your details </legend>
      <p><label><input type="checkbox" name="news" checked> Send me offers </label></p>
    </fieldset>
    <p><label>Preferred delivery time: <input type="time" name="delivery"></label></p>
    <p><label>Delivery instructions: <textarea name="comments">Ring the doorbell, please.</textarea></label></p>
    <p><label>Country <select name="country"><option>Portugal</option><option selected>Spain</option></select></label></p>
    <p><input name="coupon" aria-label="Coupon code" value="SAVE10" disabled></p>
    <p><input value="no name, so not sent"></p>
    <p><button id="submit">Submit order</button></p>
  </form>`;

test("a submit names the fields it sends something from, never their values", () => {
  const window = page(ORDER_FORM);
  const names = sentFieldNames(window, "submit");
  assert.deepEqual(names, [
    "Customer name",
    "Telephone",
    "E-mail address",
    "Pizza Size",
    "Pizza Toppings",
    "Send me offers",
    "Delivery instructions",
    "Country",
  ]);
  const said = names.join(" ");
  for (const value of [
    "Alex Example", "555-0107", "alex@example.com", "Medium", "medium", "Small", "Ring the doorbell",
    "Spain", "Portugal", "token-value-123", "csrf", "SAVE10", "Coupon", "Bacon", "Onion", "Your details",
    "Preferred delivery time", "no name",
  ]) {
    assert.ok(!said.includes(value), `${value} in ${said}`);
  }
});

test("a field a step types into before it submits counts as filled", () => {
  const window = page(`
    <form action="/search">
      <input id="query" name="q" aria-label="Search places">
      <input type="checkbox" name="open" aria-label="Open now" checked>
      <button>Search</button>
    </form>`);
  assert.deepEqual(sentFieldNames(window, "query"), ["Open now"]);
  assert.deepEqual(sentFieldNames(window, "query", true), ["Search places", "Open now"]);
});

test("names come from the page's own words: aria names, a label's words without its controls, a placeholder", () => {
  const window = page(`
    <span id="mail-label">Your e-mail</span>
    <form action="/join" method="post">
      <input name="a" aria-labelledby="mail-label" value="x">
      <label>Notes <textarea name="b"></textarea> (optional)</label>
      <input name="c" placeholder="Postcode" value="1000-001">
      <input name="d" value="y">
      <input type="checkbox" name="news" checked aria-label="Send me news">
      <button id="join">Join</button>
    </form>`);
  assert.deepEqual(sentFieldNames(window, "join"), ["Your e-mail", "Postcode", "d", "Send me news"]);
  // An empty textarea sends nothing of the person's, so it is not listed;
  // filled, its label's own words name it.
  window.document.querySelector("textarea").value = "typed note";
  assert.deepEqual(sentFieldNames(window, "join"), ["Your e-mail", "Notes (optional)", "Postcode", "d", "Send me news"]);
});

test("a dialog form sends nothing, and an element with no form has no fields", () => {
  const window = page(`
    <dialog open><form method="dialog"><input name="n" value="v"><button id="close">Close</button></form></dialog>
    <button id="loose">Loose</button>`);
  assert.deepEqual(sentFieldNames(window, "close"), []);
  assert.deepEqual(sentFieldNames(window, "loose"), []);
});
