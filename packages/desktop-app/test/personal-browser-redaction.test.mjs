import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const redaction = require(path.join(packageRoot, "dist/personalBrowserRedaction.js"));

// Every sample is assembled at run time so no key-shaped literal is committed.
const join = (...parts) => parts.join("");
const random = (length, alphabet = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xY") =>
  Array.from({ length }, (_, index) => alphabet[(index * 7 + 3) % alphabet.length]).join("");
const CANARY = join("sk", "_test_", "INSTAFYCANARY", "7Qm2Xr9Lp4Vb8Nc1");

const KNOWN_FORMATS = {
  "OpenAI-style": join("sk", "-", random(40)),
  "Anthropic-style": join("sk", "-ant-", random(40)),
  "project key": join("sk", "-proj-", random(40)),
  "live payment key": join("sk", "_live_", random(24)),
  "restricted key": join("rk", "_live_", random(24)),
  "webhook secret": join("whsec", "_", random(32)),
  "GitHub token": join("gh", "p", "_", random(36)),
  "GitHub OAuth token": join("gh", "o", "_", random(36)),
  "GitHub server token": join("gh", "s", "_", random(36)),
  "GitHub fine-grained token": join("github", "_pat", "_", random(60, "aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xY_")),
  "GitLab token": join("glpat", "-", random(24)),
  "Slack token": join("xox", "b-", random(12, "0123456789"), "-", random(24)),
  "AWS access key": join("AK", "IA", random(16, "ABCDEFGHJKLMNPQRSTUVWXYZ234567")),
  "AWS session key": join("AS", "IA", random(16, "ABCDEFGHJKLMNPQRSTUVWXYZ234567")),
  "Google API key": join("AI", "za", random(35)),
  "Google OAuth token": join("ya", "29.", random(40)),
  "npm token": join("npm", "_", random(36)),
  "Hugging Face token": join("hf", "_", random(34)),
  "Shopify token": join("shp", "at_", random(32, "0123456789abcdef")),
  "Notion token": join("ntn", "_", random(40)),
  "Notion legacy secret": join("secret", "_", random(43)),
  "SendGrid key": join("SG", ".", random(22), ".", random(43)),
  "JWT": join("ey", "J", random(20), ".", "ey", "J", random(30), ".", random(43)),
  "PEM private key": join("-----BEGIN ", "PRIVATE KEY-----\n", random(64), "\n-----END ", "PRIVATE KEY-----"),
  "Bearer value": join("Bearer ", random(40)),
  "canary": CANARY,
};

for (const [label, secret] of Object.entries(KNOWN_FORMATS)) {
  test(`known format is masked in place anywhere: ${label}`, () => {
    const result = redaction.redactText(`Before ${secret} after.`);
    assert.ok(!result.text.includes(secret), result.text);
    assert.match(result.text, /^Before .*\[redacted secret\].* after\.$/s);
    assert.ok(result.matches >= 1);
    assert.equal(redaction.matchesKnownFormat(secret), true);
  });
}

test("unknown formats are masked only near a credential word", () => {
  const opaque = random(28);
  for (const sentence of [
    `Client Secret: ${opaque}`,
    `API-Schlüssel ${opaque}`,
    `Zugangsdaten für die Schnittstelle ${opaque}`,
    `Technischer Benutzer angelegt. Wert ${opaque}`,
    `${opaque} is your signing key`,
  ]) {
    const result = redaction.redactText(sentence);
    assert.ok(!result.text.includes(opaque), sentence);
    assert.equal(result.matches, 1, sentence);
  }
  for (const sentence of [
    `Order reference ${opaque} shipped`,
    `Build ${opaque} finished`,
    "A plain sentence about keyboards and monkeys without secrets in it.",
  ]) {
    assert.equal(redaction.redactText(sentence).text, sentence);
  }
});

test("UUIDs and long hex values are left alone outside a credential context", () => {
  const uuid = "3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8";
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const sentence = `Token id ${uuid} for commit ${sha}`;
  assert.equal(redaction.redactText(sentence).text, sentence);
  const inContext = redaction.redactText(sentence, { credentialContext: true });
  assert.ok(!inContext.text.includes(uuid));
  assert.ok(!inContext.text.includes(sha));
});

test("six to eight digit codes are masked next to the word code", () => {
  assert.equal(redaction.redactText("Your verification code is 482913.").text, "Your verification code is [redacted secret].");
  assert.equal(redaction.redactText("Bestätigungscode: 48291377").text, "Bestätigungscode: [redacted secret]");
  assert.equal(redaction.redactText("Invoice 48291377 total 1.234.567,00").text, "Invoice 48291377 total 1.234.567,00");
});

test("addresses keep fragments and ordinary paths and mask only random sensitive parts", () => {
  const token = random(32);
  const cases = [
    ["https://app.example.test/docs/getting-started#install", "https://app.example.test/docs/getting-started#install"],
    ["https://app.example.test/search?q=how+to+reset+a+token", "https://app.example.test/search?q=how+to+reset+a+token"],
    ["https://code.example.test/o/r/issues?state=closed&page=2", "https://code.example.test/o/r/issues?state=closed&page=2"],
    ["https://app.example.test/settings/api-keys", "https://app.example.test/settings/api-keys"],
    [`https://app.example.test/reset/${token}`, "https://app.example.test/reset/REDACTED"],
    [`https://app.example.test/invite/${token}/accept`, "https://app.example.test/invite/REDACTED/accept"],
    [`https://app.example.test/callback?code=${token}&lang=de`, "https://app.example.test/callback?code=REDACTED&lang=de"],
    [`https://app.example.test/#/done?access_token=${token}&token_type=bearer`, "https://app.example.test/#/done?access_token=REDACTED&token_type=bearer"],
    [`https://app.example.test/x?key=${CANARY}`, "https://app.example.test/x?key=REDACTED"],
    ["https://app.example.test/items/1234/edit#section-2", "https://app.example.test/items/1234/edit#section-2"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redaction.redactUrl(input).text, expected, input);
  }
});

test("a secret screen withholds text but keeps masked control names", () => {
  const observation = redaction.redactPageObservation({
    url: "https://books.example.test/pages/apps.xhtml",
    title: "Verbundene Apps",
    text: `API-Schlüssel ${CANARY}`,
    names: ["Anzeigen", `Kopieren ${CANARY}`, undefined],
    signals: { credentialContext: true, secretField: false, secretCode: false, maskedNearReveal: false },
  });
  assert.equal(observation.secretScreen, true);
  assert.equal(observation.text, "");
  assert.match(observation.message, /withheld/);
  assert.deepEqual(observation.names, ["Anzeigen", "Kopieren [redacted secret]", undefined]);
  assert.ok(!JSON.stringify(observation).includes(CANARY));
});

test("page-side yes/no signals alone make a secret screen", () => {
  for (const signal of ["secretField", "maskedNearReveal"]) {
    const observation = redaction.redactPageObservation({
      url: "https://app.example.test/", title: "Settings", text: "Ordinary text", names: [],
      signals: { [signal]: true },
    });
    assert.equal(observation.secretScreen, true, signal);
    assert.equal(observation.text, "");
  }
  const codeOutsideContext = redaction.redactPageObservation({
    url: "https://docs.example.test/", title: "Quickstart", text: "Install the client", names: [],
    signals: { secretCode: true },
  });
  assert.equal(codeOutsideContext.secretScreen, false);
});

test("documentation examples are masked in place, not withheld", () => {
  const example = join("AK", "IA", "IOSFODNN7", "EXAMPLE");
  const docs = redaction.redactPageObservation({
    url: "https://docs.example.test/auth",
    title: "Authentication",
    text: `Set the header Authorization: Bearer $TOKEN. Your key looks like ${KNOWN_FORMATS["OpenAI-style"]}.`,
    names: ["Copy"],
    signals: { credentialContext: false },
  });
  assert.equal(docs.secretScreen, false);
  assert.ok(docs.text.includes("[redacted secret]"));
  assert.ok(docs.text.includes("Bearer $TOKEN"));

  const placeholder = redaction.redactPageObservation({
    url: "https://docs.example.test/aws",
    title: "Access keys",
    text: `Example: ${example}`,
    names: [],
    signals: { credentialContext: true },
  });
  assert.equal(placeholder.secretScreen, false, "an obvious placeholder does not withhold the page");
  assert.ok(!placeholder.text.includes(example));
});

test("a page withheld earlier stays withheld whatever its text", () => {
  const observation = redaction.redactPageObservation({
    url: "https://app.example.test/", title: "Home", text: "Nothing secret", names: ["Back"],
    signals: {}, withhold: true,
  });
  assert.equal(observation.secretScreen, true);
  assert.equal(observation.text, "");
  assert.deepEqual(observation.names, ["Back"]);
});

test("log payloads are masked recursively, including addresses inside messages", () => {
  const masked = redaction.redactLogValue({
    message: `ERR_ABORTED loading 'https://app.example.test/x?token=${CANARY}'`,
    nested: [{ value: `api key ${CANARY}` }],
    count: 3,
  });
  assert.ok(!JSON.stringify(masked).includes(CANARY));
  assert.equal(masked.count, 3);
});
