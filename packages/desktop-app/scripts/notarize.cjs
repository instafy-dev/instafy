const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { finalizeRuntimeAgentManifest } = require("./finalize-runtime-agent-manifest.cjs");

function requiredEnv(name) {
  return String(process.env[name] ?? "").trim();
}

exports.default = async function notarizeApp(context) {
  if (process.platform === "win32") {
    // electron-builder's signExts pass has already Authenticode-signed the
    // nested runtime at afterSign. Hash those final bytes before NSIS packs
    // the application directory into the signed installer.
    finalizeRuntimeAgentManifest(context);
    return;
  }
  if (process.platform !== "darwin") return;
  if (
    requiredEnv("CSC_IDENTITY_AUTO_DISCOVERY").toLowerCase() === "false" &&
    !requiredEnv("CSC_LINK") &&
    !requiredEnv("CSC_NAME")
  ) {
    // electron-builder can still emit afterSign for an explicitly unsigned
    // package. afterPack already finalized the correct unsigned runtime hash;
    // do not add an ad-hoc outer signature to that engineering build.
    console.log("[desktop-app] Skipping post-sign manifest finalization for an unsigned macOS build.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // The nested runtime is signed as part of Electron's first signing pass, which
  // changes its bytes after afterPack. Finalize the checksum over those signed
  // bytes, then re-seal only the outer app bundle before notarization. Do not use
  // --deep for this second signing pass: that would mutate the nested runtime a
  // second time and invalidate the manifest again.
  finalizeRuntimeAgentManifest(context);
  const inspection = spawnSync("codesign", ["-dvvv", appPath], {
    encoding: "utf8",
  });
  if (inspection.error) throw inspection.error;
  if (inspection.status !== 0) {
    throw new Error(`Unable to inspect the signed application bundle: ${inspection.stderr}`);
  }
  const signatureDetails = `${inspection.stdout || ""}\n${inspection.stderr || ""}`;
  const authority = /^Authority=(.+)$/m.exec(signatureDetails)?.[1]?.trim();
  const isAdHoc = /^Signature=adhoc$/m.test(signatureDetails);
  if (!authority && !isAdHoc) {
    throw new Error("Unable to resolve the existing macOS code-signing identity.");
  }

  const resignArgs = [
    "--force",
    "--sign",
    authority || "-",
    "--preserve-metadata=identifier,entitlements,requirements,flags",
  ];
  if (authority) resignArgs.push("--timestamp");
  const codeSigningInfo = context.packager.codeSigningInfo?.value
    ? await context.packager.codeSigningInfo.value
    : null;
  if (codeSigningInfo?.keychainFile) {
    resignArgs.push("--keychain", codeSigningInfo.keychainFile);
  }
  resignArgs.push(appPath);
  const resign = spawnSync("codesign", resignArgs, { encoding: "utf8" });
  if (resign.error) throw resign.error;
  if (resign.status !== 0) {
    throw new Error(`Unable to re-seal the application bundle: ${resign.stderr}`);
  }
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    encoding: "utf8",
  });
  if (verify.error) throw verify.error;
  if (verify.status !== 0) {
    throw new Error(`Re-sealed application bundle failed verification: ${verify.stderr}`);
  }

  const appleId = requiredEnv("APPLE_ID");
  const appleIdPassword = requiredEnv("APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = requiredEnv("APPLE_TEAM_ID");
  if (!appleId || !appleIdPassword || !teamId) {
    // Keep local dev builds working without requiring Apple credentials.
    console.log("[desktop-app] Skipping notarization (missing APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID).");
    return;
  }

  // Lazy-load to avoid requiring the dependency in non-mac environments.
  // eslint-disable-next-line global-require
  const { notarize } = require("@electron/notarize");

  console.log(`[desktop-app] Notarizing ${appPath}`);
  await notarizeWithRetry({ appPath, appleId, appleIdPassword, teamId, notarize });
};

// Notarization is a long upload followed by minutes of polling Apple, at the
// very end of a build that already cost the better part of an hour. A dropped
// connection there is not a signing problem and should not throw the whole
// build away: run 30822804681 failed on
// NSURLErrorDomain -1009 ("The Internet connection appears to be offline")
// while polling a submission Apple had already accepted.
//
// Only transport-shaped failures are retried. A rejected submission, bad
// credentials or an invalid bundle must still fail immediately — retrying those
// would burn an hour to arrive at the same answer.
//
// Every attempt is also bounded. `notarytool submit --wait` polls Apple with no
// timeout of its own, so a poll that stops making progress hangs until the job
// ceiling kills it — which is what happened on run 30839030282: 1h58m inside a
// single silent notarization, no artifact, nothing in the log to say why. A
// bounded attempt turns that into a named failure and a retry.
// A healthy notarization of this bundle takes ~20 minutes (run 30822804681
// signed and submitted in 22m53s before its network dropped), so 45 minutes is
// generous for one attempt. The total matters more than the per-attempt bound:
// three 45-minute attempts would still swallow the job ceiling and leave the
// same "no artifact, no explanation" outcome. Cap the whole effort instead.
const ATTEMPT_TIMEOUT_MS = Number(process.env.NOTARIZE_ATTEMPT_TIMEOUT_MS || 45 * 60_000);
const TOTAL_TIMEOUT_MS = Number(process.env.NOTARIZE_TOTAL_TIMEOUT_MS || 100 * 60_000);
const BACKOFF_BASE_MS = Number(process.env.NOTARIZE_BACKOFF_MS || 30_000);

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        // Deliberately not unref'd. An unref'd timer does not hold the event
        // loop open, so whether the deadline fires depends on what else happens
        // to be pending — which is precisely the case a deadline exists to
        // catch. The finally below clears it the moment the race settles, so it
        // only keeps the process alive while notarization is genuinely running.
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const TRANSIENT_NOTARIZATION_PATTERNS = [
  /connection appears to be offline/i,
  /NSURLErrorDomain/i,
  /network (is )?(unreachable|down)/i,
  /timed? ?out/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i,
  /502|503|504|Bad Gateway|Service Unavailable|Gateway Time-?out/i,
];

function isTransientNotarizationFailure(error) {
  const text = `${error?.message ?? ""} ${error?.stack ?? ""}`;
  return TRANSIENT_NOTARIZATION_PATTERNS.some((pattern) => pattern.test(text));
}

async function notarizeWithRetry({ appPath, appleId, appleIdPassword, teamId, notarize }) {
  const attempts = Number(process.env.NOTARIZE_ATTEMPTS || 3);
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Notarization exhausted its ${TOTAL_TIMEOUT_MS}ms budget after ${attempt - 1} attempt(s).`,
      );
    }
    try {
      const startedAt = Date.now();
      await withTimeout(
        notarize({ appPath, appleId, appleIdPassword, teamId }),
        Math.min(ATTEMPT_TIMEOUT_MS, remaining),
        `Notarization attempt ${attempt}/${attempts}`,
      );
      console.log(
        `[desktop-app] Notarization succeeded in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
      );
      return;
    } catch (error) {
      const transient = isTransientNotarizationFailure(error);
      if (!transient || attempt === attempts) {
        if (!transient) {
          console.error("[desktop-app] Notarization failed for a non-transport reason; not retrying.");
        }
        throw error;
      }
      const backoffMs = Math.max(0, Math.min(BACKOFF_BASE_MS * attempt, deadline - Date.now()));
      console.warn(
        `[desktop-app] Notarization attempt ${attempt}/${attempts} hit a transport failure ` +
          `(${(error?.message ?? "").split("\n")[0].slice(0, 160)}); retrying in ${backoffMs / 1000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

module.exports.withTimeout = withTimeout;
module.exports.isTransientNotarizationFailure = isTransientNotarizationFailure;
module.exports.notarizeWithRetry = notarizeWithRetry;
