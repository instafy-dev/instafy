import crypto from "node:crypto";

const PLATFORM_VALUES = new Set(["ios", "android"]);
const STATUS_VALUES = new Set(["draft", "live", "paused", "rolled_back", "archived"]);

export function createBundleVersion({ createdAt = new Date().toISOString(), gitSha = "local" } = {}) {
  const normalizedDate = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const shortSha = gitSha.slice(0, 8);
  return `${normalizedDate}-${shortSha}`;
}

export function buildReleaseId({ platform, channel, bundleVersion }) {
  return `${platform}-${channel}-${bundleVersion}`;
}

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function signBufferWithRsaSha256(buffer, privateKeyPem) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(buffer);
  sign.end();
  return sign.sign(privateKeyPem, "base64");
}

export function verifyBufferSignatureWithRsaSha256(buffer, signature, publicKeyPem) {
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(buffer);
  verify.end();
  return verify.verify(publicKeyPem, signature, "base64");
}

export function buildBundleManifest({
  bundleVersion,
  gitSha,
  createdAt,
  archiveFileName,
  archiveSha256,
  archiveSignature = null,
  archiveSizeBytes,
  sourceDir,
}) {
  return {
    schema_version: 1,
    bundle_version: bundleVersion,
    git_sha: gitSha,
    created_at: createdAt,
    source_dir: sourceDir,
    artifact_type: "zip",
    archive_file_name: archiveFileName,
    archive_sha256: archiveSha256,
    archive_signature: archiveSignature,
    archive_size_bytes: archiveSizeBytes,
  };
}

export function buildReleaseRegistration({
  manifest,
  artifactUrl,
  platform,
  channel,
  nativeVersion,
  minSupportedNativeVersion = nativeVersion,
  rolloutPercentage = 100,
  status = "draft",
  notes = null,
  publishedAt = new Date().toISOString(),
  publishedBy = "github-actions",
  signature = manifest.archive_signature ?? null,
}) {
  if (!PLATFORM_VALUES.has(platform)) {
    throw new Error(`Unsupported OTA platform: ${platform}`);
  }
  if (!STATUS_VALUES.has(status)) {
    throw new Error(`Unsupported OTA release status: ${status}`);
  }
  if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100) {
    throw new Error(`rolloutPercentage must be an integer between 0 and 100; received ${rolloutPercentage}`);
  }

  const bundleVersion = manifest.bundle_version;
  return {
    release_id: buildReleaseId({ platform, channel, bundleVersion }),
    platform,
    channel,
    bundle_version: bundleVersion,
    git_sha: manifest.git_sha,
    native_version: nativeVersion,
    min_supported_native_version: minSupportedNativeVersion,
    artifact_url: artifactUrl,
    artifact_sha256: manifest.archive_sha256,
    artifact_size_bytes: manifest.archive_size_bytes,
    artifact_type: manifest.artifact_type,
    signature,
    rollout_percentage: rolloutPercentage,
    status,
    published_at: publishedAt,
    published_by: publishedBy,
    notes,
  };
}
