import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

// What a prompt says a form step sends (@instafy/browser-action-policy's
// sentFields, which the Shared Browser runs in the page before it asks): the
// fields the submission sends something from, by the names the page gives
// them, and never a value, with how many it sends in all. A submit prompt
// that only named its button left the person to guess what would leave the
// page.
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

function sentFields(window, id, typed = false) {
  const rules = window.eval(`(${formSubmission.formSubmissionRulesInPage.toString()})()`);
  const sent = rules.sentFields(window.document.getElementById(id), typed);
  // An answer of the page's realm, copied into this one.
  return { names: [...sent.names], count: sent.count };
}

function sentFieldNames(window, id, typed = false) {
  return sentFields(window, id, typed).names;
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
  const { names, count } = sentFields(window, "submit");
  assert.equal(count, names.length, "Every field it sends is named");
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

test("boxes that answer one question are named by the question, never by the boxes ticked", () => {
  // A list of boxes is a choice, like a radio group, whatever their name
  // attributes: naming the ticked ones would say the person's answers.
  const window = page(`
    <form method="post" action="/intake">
      <p><label>Name <input name="name" value="Alex Example"></label></p>
      <fieldset>
        <legend>Conditions you have</legend>
        <label><input type="checkbox" name="cond_diabetes"> Diabetes</label>
        <label><input type="checkbox" name="cond_hiv" checked> HIV</label>
        <label><input type="checkbox" name="cond_pregnant" checked> Pregnant</label>
      </fieldset>
      <div role="group">
        <label><input type="checkbox" name="smoker" checked> I smoke</label>
        <label><input type="checkbox" name="drinker"> I drink</label>
      </div>
      <button id="send">Send</button>
    </form>`);
  const names = sentFieldNames(window, "send");
  assert.deepEqual(names, ["Name", "Conditions you have", "Ticked boxes"]);
  const said = names.join(" ");
  for (const answer of ["Diabetes", "HIV", "Pregnant", "cond_", "smoke", "drink"]) {
    assert.ok(!said.includes(answer), `${answer} in ${said}`);
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

test("the fields a step typed into on the page come first, by their labels, whether or not the form posts them", () => {
  // A planner's stops are fields its own script reads, with no name its form
  // posts them by: a prompt named only its day and time fields while the
  // script sent the stops. Then the rest of what the form sends; never a field
  // typed into in another form, or one the page has emptied since.
  const window = page(`
    <form method="post" action="/route">
      <label for="from">From</label><input id="from" role="combobox" value="Sao Bento">
      <label for="to">To</label><input id="to" role="combobox" value="Trindade">
      <label for="via">Via</label><input id="via" role="combobox" value="">
      <input id="nameless" value="Line D">
      <label for="day">Day</label><input id="day" type="date" name="day" value="2026-10-31">
      <label for="time">Time</label><input id="time" type="time" name="time" value="09:00">
      <button id="find">Find connections</button>
    </form>
    <form action="/search"><label for="q">Search the site</label><input id="q" name="q" value="timetables"></form>`);
  const rules = window.eval(`(${formSubmission.formSubmissionRulesInPage.toString()})()`);
  const byId = (id) => window.document.getElementById(id);
  const typed = ["from", "to", "via", "nameless", "q"].map(byId);
  const sent = (id, typedHere = false) => {
    const answer = rules.sentFields(byId(id), typedHere, typed);
    return { names: [...answer.names], count: answer.count };
  };
  // The button, and Enter in a stop: the stops first, then the day and the
  // time; the field with no name a person knows it by is counted.
  assert.deepEqual(sent("find"), { names: ["From", "To", "Day", "Time"], count: 5 });
  assert.deepEqual(sent("to"), { names: ["From", "To", "Day", "Time"], count: 5 });
  // Typing into a field with submit fills it first: it comes first.
  assert.deepEqual(sent("via", true), { names: ["Via", "From", "To", "Day", "Time"], count: 6 });
  // With no field typed into, the stops are not named: what the browser's own
  // post sends.
  assert.deepEqual(sentFieldNames(window, "find"), ["Day", "Time"]);
  // A typed field the page took out of its form or emptied is not named.
  byId("to").value = "";
  byId("from").remove();
  assert.deepEqual(sent("find"), { names: ["Day", "Time"], count: 3 });
  const said = sent("find").names.join(" ");
  for (const value of ["Sao Bento", "Trindade", "Line D", "timetables", "Search the site"]) {
    assert.ok(!said.includes(value), `${value} in ${said}`);
  }
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
  assert.deepEqual(sentFields(window, "close"), { names: [], count: 0 });
  assert.deepEqual(sentFields(window, "loose"), { names: [], count: 0 });
});

test("a form that sends more than 24 fields names the first 24 and says how many it sends in all", () => {
  // A prompt that listed only the names would read the longer form as
  // complete.
  const window = page(`
    <form method="post" action="/apply">
      ${Array.from({ length: 30 }, (_, n) => `<label>Q${n + 1} <input name="q${n + 1}" value="answer ${n + 1}"></label>`).join("")}
      <button id="apply">Apply</button>
    </form>`);
  const { names, count } = sentFields(window, "apply");
  assert.deepEqual(names, Array.from({ length: 24 }, (_, n) => `Q${n + 1}`));
  assert.equal(count, 30);
  assert.ok(!names.join(" ").includes("answer"), names.join(" "));
});
