import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HELPER = path.join(import.meta.dirname, "upload-keystore.sh");
const keytoolAvailable = spawnSync("keytool", ["-help"], { encoding: "utf8" }).error === undefined;
// Fixture-only credentials for a throwaway keystore generated per run.
const STORE_PASSWORD = ["fixture", "store", "pw"].join("-");
const ALIAS = "upload";

function withKeystore(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-keystore-test-"));
  try {
    const store = path.join(root, "fixture.p12");
    const generated = spawnSync("keytool", [
      "-genkeypair", "-keystore", store, "-storetype", "PKCS12", "-storepass", STORE_PASSWORD,
      "-alias", ALIAS, "-keyalg", "RSA", "-keysize", "2048", "-validity", "1", "-dname", "CN=fixture",
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const runnerTemp = path.join(root, "runner-temp");
    fs.mkdirSync(runnerTemp);
    const output = path.join(root, "github-output");
    fs.writeFileSync(output, "");
    const run = (action, overrides = {}) => spawnSync("bash", [HELPER, action], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: output,
        ANDROID_UPLOAD_KEYSTORE_B64: fs.readFileSync(store).toString("base64"),
        ANDROID_UPLOAD_KEYSTORE_TYPE: "PKCS12",
        ANDROID_UPLOAD_KEYSTORE_PASSWORD: STORE_PASSWORD,
        ANDROID_UPLOAD_KEY_ALIAS: ALIAS,
        ...overrides,
      },
    });
    callback({ run, signingDir: path.join(runnerTemp, "instafy-android-signing"), output });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

test("prove checks the alias and leaves nothing on disk", { skip: !keytoolAvailable && "keytool unavailable" }, () => {
  withKeystore(({ run, signingDir, output }) => {
    const result = run("prove");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(signingDir), false);
    assert.equal(fs.readFileSync(output, "utf8"), "");
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(STORE_PASSWORD, "u"));
  });
});

test("materialize writes a 0600 keystore in a 0700 directory and remove deletes it", { skip: !keytoolAvailable && "keytool unavailable" }, () => {
  withKeystore(({ run, signingDir, output }) => {
    const result = run("materialize");
    assert.equal(result.status, 0, result.stderr);
    const keystore = path.join(signingDir, "upload.keystore");
    assert.equal(fs.readFileSync(output, "utf8"), `path=${keystore}\n`);
    assert.equal(fs.statSync(signingDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(keystore).mode & 0o777, 0o600);
    assert.equal(run("remove").status, 0);
    assert.equal(fs.existsSync(signingDir), false);
  });
});

test("a wrong alias, password or missing secret fails closed and removes the file", { skip: !keytoolAvailable && "keytool unavailable" }, () => {
  withKeystore(({ run, signingDir }) => {
    for (const overrides of [
      { ANDROID_UPLOAD_KEY_ALIAS: "other" },
      { ANDROID_UPLOAD_KEYSTORE_PASSWORD: "wrong-password" },
      { ANDROID_UPLOAD_KEYSTORE_B64: "" },
    ]) {
      for (const action of ["prove", "materialize"]) {
        const result = run(action, overrides);
        assert.equal(result.status, 1, `${action} ${Object.keys(overrides)[0]}`);
        assert.match(result.stderr, /::error::/u);
        assert.equal(fs.existsSync(signingDir), false);
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(STORE_PASSWORD, "u"));
      }
    }
    assert.equal(run("unknown").status, 1);
  });
});
