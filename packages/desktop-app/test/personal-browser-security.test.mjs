import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const modulePath = path.join(packageRoot, "dist", "personalBrowserSecurity.js");
const {
  PERSONAL_BROWSER_PARTITION_PREFIX,
  constantTimePersonalBrowserTokenMatch,
  derivePersonalBrowserPartition,
  isAllowedPersonalBrowserControlHost,
  isHighImpactPersonalBrowserAction,
  isPersonalBrowserActivationKey,
  isPersonalBrowserFeatureEnabled,
  isSensitivePersonalBrowserEditable,
  normalizePersonalBrowserBounds,
  normalizePersonalBrowserApprovalMode,
  normalizePersonalBrowserPressKey,
  normalizePersonalBrowserProfileUserId,
  normalizePersonalBrowserScroll,
  normalizePersonalBrowserUrl,
  readPersonalBrowserBearerToken,
  personalBrowserActivationTargetsMatch,
  personalBrowserActivationRequiresConfirmation,
  personalBrowserKeyRequiresConfirmation,
  personalBrowserKeyMutatesSensitiveField,
  personalBrowserTargetSecurityFingerprint,
  requirePersonalBrowserTarget,
  sanitizePersonalBrowserBrokerStatus,
} = await import(modulePath);

test("routine browsing is an explicit mode and cannot disable consequential or secret safeguards", () => {
  assert.equal(normalizePersonalBrowserApprovalMode(undefined), "ask");
  assert.equal(normalizePersonalBrowserApprovalMode("routine"), "routine");
  for (const invalid of [null, true, "always", "all", "ROUTINE", {}, 1]) {
    assert.throws(() => normalizePersonalBrowserApprovalMode(invalid), /approval mode/);
  }
  const ordinary = { tag: "a", text: "Documentation", href: "https://example.test/docs" };
  assert.equal(personalBrowserActivationRequiresConfirmation(ordinary), true);
  assert.equal(personalBrowserActivationRequiresConfirmation(ordinary, "routine"), false);
  for (const target of [
    { tag: "button", type: "button", ariaLabel: "Delete account" },
    { tag: "a", text: "Continue", href: "https://example.test/purchase" },
    { tag: "input", type: "submit" },
    { tag: "button", type: "submit", formActionText: "this form" },
    { tag: "button", formActionText: "Search" },
  ]) {
    assert.equal(personalBrowserActivationRequiresConfirmation(target, "routine"), true);
  }
  assert.equal(personalBrowserKeyRequiresConfirmation("Enter", { tag: "input", type: "text" }, "routine"), true);
  assert.equal(personalBrowserKeyRequiresConfirmation(" ", ordinary, "routine"), true);
  assert.equal(personalBrowserKeyRequiresConfirmation("Tab", ordinary, "routine"), false);
  assert.equal(isSensitivePersonalBrowserEditable({ type: "password" }), true);
  assert.equal(isSensitivePersonalBrowserEditable({ autocomplete: "one-time-code" }), true);
  assert.equal(isSensitivePersonalBrowserEditable({ autocomplete: "cc-number" }), true);
});

test("routine submission confirmation uses native semantics rather than form wording", () => {
  for (const descriptor of [
    { tag: "button", type: "submit", formOwnerIdentity: "form-owner" },
    { tag: "button", type: "submit", formOwnerIdentity: "form-owner", formActionText: "" },
    { tag: "button", formOwnerIdentity: "form-owner" },
    { tag: "button", type: "submit" },
    { tag: "button" },
    { tag: "input", type: "image", formOwnerIdentity: "form-owner" },
  ]) {
    assert.equal(personalBrowserActivationRequiresConfirmation(descriptor, "routine"), true);
  }
  for (const descriptor of [
    { tag: "button", type: "button", formOwnerIdentity: "form-owner", formActionText: "Details" },
    { tag: "button", type: "reset", formOwnerIdentity: "form-owner", formActionText: "Details" },
    { tag: "button", type: "submit", formOwnerIdentity: "" },
  ]) {
    assert.equal(personalBrowserActivationRequiresConfirmation(descriptor, "routine"), false);
  }
  assert.equal(personalBrowserKeyRequiresConfirmation("Enter", { tag: "input", type: "text", formOwnerIdentity: "form-owner", formActionText: "" }), true);
});

test("Personal Browser is enabled by default with an explicit emergency kill switch", () => {
  assert.equal(isPersonalBrowserFeatureEnabled(undefined), true);
  assert.equal(isPersonalBrowserFeatureEnabled(""), true);
  assert.equal(isPersonalBrowserFeatureEnabled("0"), false);
  assert.equal(isPersonalBrowserFeatureEnabled("false"), false);
  assert.equal(isPersonalBrowserFeatureEnabled(" OFF "), false);
  assert.equal(isPersonalBrowserFeatureEnabled("1"), true);
  assert.equal(isPersonalBrowserFeatureEnabled(" ON "), true);
});

test("Personal Browser partitions are persistent, deterministic hashes without raw identity", () => {
  const first = derivePersonalBrowserPartition(" user-123@example.test ");
  const repeated = derivePersonalBrowserPartition("user-123@example.test");
  const other = derivePersonalBrowserPartition("user-456@example.test");

  assert.equal(first, repeated);
  assert.notEqual(first, other);
  assert.equal(first.startsWith(PERSONAL_BROWSER_PARTITION_PREFIX), true);
  assert.equal(first.includes("user-123"), false);
  assert.match(first, /^persist:instafy-personal-[a-f0-9]{40}$/);
});

test("Personal Browser preload identity accepts only canonical UUID account identifiers", () => {
  assert.equal(
    normalizePersonalBrowserProfileUserId(" AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE "),
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  assert.throws(() => normalizePersonalBrowserProfileUserId("user@example.test"));
  assert.throws(() => normalizePersonalBrowserProfileUserId("../../another-partition"));
});

test("Personal Browser URL policy allows only credential-free http(s) and exact about:blank", () => {
  assert.equal(normalizePersonalBrowserUrl("about:blank"), "about:blank");
  assert.equal(normalizePersonalBrowserUrl("https://example.test/a"), "https://example.test/a");
  assert.equal(normalizePersonalBrowserUrl("http://127.0.0.1:5173"), "http://127.0.0.1:5173/");

  for (const blocked of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///etc/passwd",
    "about:config",
    "https://user:secret@example.test",
    "example.test",
  ]) {
    assert.throws(() => normalizePersonalBrowserUrl(blocked));
  }
});

test("Personal Browser bounds and agent targets reject unsafe input", () => {
  assert.deepEqual(normalizePersonalBrowserBounds({ x: 10.2, y: 20.8, width: 300, height: 200 }), {
    x: 10,
    y: 21,
    width: 300,
    height: 200,
  });
  assert.throws(() => normalizePersonalBrowserBounds({ x: -1, y: 0, width: 10, height: 10 }));
  assert.throws(() => normalizePersonalBrowserBounds({ x: 0, y: 0, width: 0, height: 10 }));
  assert.deepEqual(requirePersonalBrowserTarget({ index: 0 }), { index: 0 });
  assert.throws(() => requirePersonalBrowserTarget({}));
  assert.throws(() => requirePersonalBrowserTarget({ selector: "button" }));
  assert.throws(() => requirePersonalBrowserTarget({ index: 500 }));
  assert.equal(normalizePersonalBrowserPressKey("Enter"), "Enter");
  assert.throws(() => normalizePersonalBrowserPressKey("Control+L"));
  assert.deepEqual(normalizePersonalBrowserScroll({ x: 50_000, y: -50_000 }), {
    x: 10_000,
    y: -10_000,
  });
});

test("Personal Browser hard-blocks password, OTP, and payment field typing", () => {
  const blocked = [
    { type: "password" },
    { autocomplete: "current-password" },
    { autocomplete: "one-time-code" },
    { autocomplete: "section-checkout cc-number" },
    { name: "verification_code" },
    { ariaLabel: "Card number" },
    { placeholder: "CVC" },
  ];
  for (const descriptor of blocked) {
    assert.equal(isSensitivePersonalBrowserEditable(descriptor), true, JSON.stringify(descriptor));
  }
  assert.equal(
    isSensitivePersonalBrowserEditable({ name: "shipping_address", type: "text" }),
    false,
  );
  assert.equal(isSensitivePersonalBrowserEditable({ name: "search", type: "text" }), false);
});

test("Space and Enter are treated as activations and mutating keys stay blocked on secrets", () => {
  assert.equal(isPersonalBrowserActivationKey("Enter"), true);
  assert.equal(isPersonalBrowserActivationKey(" "), true);
  assert.equal(isPersonalBrowserActivationKey("Tab"), false);
  for (const key of ["Enter", " ", "Backspace", "Delete"]) {
    assert.equal(personalBrowserKeyMutatesSensitiveField(key), true, key);
  }
  assert.equal(personalBrowserKeyMutatesSensitiveField("ArrowDown"), false);
});

test("Enter on an implicit form with no submit button still requires one-shot confirmation", () => {
  const implicitFormInput = {
    tag: "input",
    type: "text",
    ariaLabel: "Search",
    // The page bridge emits this marker for every enclosing form, even when a
    // hostile or minimal page omits all submit controls.
    formActionText: "this form",
  };
  assert.equal(personalBrowserActivationRequiresConfirmation(implicitFormInput), false);
  assert.equal(personalBrowserKeyRequiresConfirmation("Enter", implicitFormInput), true);
  assert.equal(personalBrowserKeyRequiresConfirmation(" ", implicitFormInput), false);
  assert.equal(
    personalBrowserKeyRequiresConfirmation("Enter", {
      tag: "input",
      type: "text",
      ariaLabel: "Search",
    }),
    false,
  );
});

test("post-consent target matching rejects page, identity, and security-label swaps", () => {
  const expected = {
    url: "https://example.test/form",
    origin: "https://example.test",
    descriptor: { identity: "target-1", tag: "button", text: "Continue" },
  };
  assert.equal(personalBrowserActivationTargetsMatch(expected, structuredClone(expected)), true);
  assert.equal(
    personalBrowserActivationTargetsMatch(expected, {
      ...structuredClone(expected),
      descriptor: { ...expected.descriptor, identity: "target-2" },
    }),
    false,
  );
  assert.equal(
    personalBrowserActivationTargetsMatch(expected, {
      ...structuredClone(expected),
      url: "https://example.test/checkout",
    }),
    false,
  );
  assert.equal(
    personalBrowserActivationTargetsMatch(expected, {
      ...structuredClone(expected),
      descriptor: { ...expected.descriptor, text: "Pay now" },
    }),
    false,
  );
  assert.equal(
    personalBrowserActivationTargetsMatch(expected, {
      ...structuredClone(expected),
      descriptor: { ...expected.descriptor, role: "link" },
    }),
    false,
  );
  assert.notEqual(
    personalBrowserTargetSecurityFingerprint(expected.descriptor),
    personalBrowserTargetSecurityFingerprint({ ...expected.descriptor, role: "link" }),
  );
});

test("broker status hides page identity while paused or awaiting origin approval", () => {
  const status = {
    state: "ready",
    url: "https://mail.example.test/private",
    title: "Private inbox",
  };
  assert.deepEqual(sanitizePersonalBrowserBrokerStatus(status, false), {
    state: "ready",
    url: "",
  });
  assert.equal(sanitizePersonalBrowserBrokerStatus(status, true), status);
});

test("Personal Browser identifies high-impact external actions conservatively", () => {
  for (const text of [
    "Buy now",
    "Pay $10",
    "Delete project",
    "Send message",
    "Publish",
    "Allow access",
    "Book appointment",
    "Reserve a table",
    "Sign contract",
  ]) {
    assert.equal(isHighImpactPersonalBrowserAction({ text }), true, text);
  }
  assert.equal(isHighImpactPersonalBrowserAction({ text: "Read documentation" }), false);
  assert.equal(isHighImpactPersonalBrowserAction({ text: "Sign in" }), false);
});

test("Personal Browser confirms button, link, and form-like activations regardless of wording", () => {
  for (const descriptor of [
    { tag: "button", text: "Continue" },
    { role: "button", text: "Accepter" },
    { tag: "a", href: "https://example.test/settings", text: "Weiter" },
    { tag: "input", type: "submit", value: "Guardar" },
  ]) {
    assert.equal(personalBrowserActivationRequiresConfirmation(descriptor), true);
  }
  assert.equal(
    personalBrowserActivationRequiresConfirmation({ tag: "input", type: "text" }),
    false,
  );
});

test("loopback control authentication requires a strict bearer token and exact Host", () => {
  const token = "a".repeat(43);
  assert.equal(readPersonalBrowserBearerToken(`Bearer ${token}`), token);
  assert.equal(readPersonalBrowserBearerToken(`Basic ${token}`), null);
  assert.equal(constantTimePersonalBrowserTokenMatch(token, token), true);
  assert.equal(constantTimePersonalBrowserTokenMatch(`${token}x`, token), false);
  assert.equal(constantTimePersonalBrowserTokenMatch(null, token), false);
  assert.equal(isAllowedPersonalBrowserControlHost("127.0.0.1:41234", 41234), true);
  assert.equal(isAllowedPersonalBrowserControlHost("localhost:41234", 41234), false);
  assert.equal(isAllowedPersonalBrowserControlHost("attacker.test", 41234), false);
});
