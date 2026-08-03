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
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await notarize({ appPath, appleId, appleIdPassword, teamId });
      return;
    } catch (error) {
      const transient = isTransientNotarizationFailure(error);
      if (!transient || attempt === attempts) {
        if (!transient) {
          console.error("[desktop-app] Notarization failed for a non-transport reason; not retrying.");
        }
        throw error;
      }
      const backoffMs = 30_000 * attempt;
      console.warn(
        `[desktop-app] Notarization attempt ${attempt}/${attempts} hit a transport failure ` +
          `(${(error?.message ?? "").split("\n")[0].slice(0, 160)}); retrying in ${backoffMs / 1000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

module.exports.isTransientNotarizationFailure = isTransientNotarizationFailure;
module.exports.notarizeWithRetry = notarizeWithRetry;
