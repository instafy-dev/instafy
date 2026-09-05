import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { buildNativeOtaChannelMarker } from "./nativeOtaChannel.js";
import { sanitizeCodexSubscriptionAuthJson } from "./tests/playwright/utils/codexSubscriptionAuthJson.js";
import {
  FRONTEND_FEATURE_MANIFEST_ENV,
  resolveFrontendFeatureManifest,
} from "./featureManifestSelector.js";

function normalizeChunkId(id: string): string {
  return id.replace(/\\/g, "/");
}

function matchesChunkGroup(id: string, needles: string[]): boolean {
  return needles.some((needle) => id.includes(needle));
}

function resolveManualChunk(id: string): string | undefined {
  const normalized = normalizeChunkId(id);

  if (normalized.includes("commonjsHelpers.js") || normalized.includes("\0commonjsHelpers")) {
    return "vendor-commonjs";
  }

  if (normalized.includes("/node_modules/")) {
    if (
      matchesChunkGroup(normalized, [
        "/node_modules/react/",
        "/node_modules/react-dom/",
        "/node_modules/react-router/",
        "/node_modules/react-router-dom/",
        "/node_modules/scheduler/",
        "/node_modules/use-sync-external-store/",
      ])
    ) {
      return "vendor-react";
    }
    if (matchesChunkGroup(normalized, ["monaco-editor", "@monaco-editor/react"])) {
      return "vendor-editor";
    }
    if (matchesChunkGroup(normalized, ["@novnc/novnc"])) {
      return "vendor-browser-rfb";
    }
    if (
      matchesChunkGroup(normalized, [
        "iconoir-react",
        "react-aria-components",
        "react-resizable-panels",
        "@dnd-kit/",
      ])
    ) {
      return "vendor-ui";
    }
    if (matchesChunkGroup(normalized, ["@tanstack/react-query", "zustand"])) {
      return "vendor-state";
    }
    if (matchesChunkGroup(normalized, ["@supabase/supabase-js"])) {
      return "vendor-supabase";
    }
    if (matchesChunkGroup(normalized, ["/lexical/", "/@lexical/"])) {
      return "vendor-lexical";
    }
    if (matchesChunkGroup(normalized, ["react-markdown", "remark-gfm"])) {
      return "vendor-markdown";
    }
    return undefined;
  }

  return undefined;
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return typeof packageJson.version === "string" && packageJson.version.trim().length > 0
      ? packageJson.version.trim()
      : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

function readGitValue(command: string): string | null {
  try {
    const value = execSync(command, {
      cwd: new URL(".", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const packageVersion = readPackageVersion();
const gitCommit =
  (process.env.VITE_BUILD_GIT_SHA ?? process.env.GITHUB_SHA ?? readGitValue("git rev-parse HEAD") ?? "").trim() ||
  null;
const gitCommitShort =
  (process.env.VITE_BUILD_GIT_SHA_SHORT ?? readGitValue("git rev-parse --short HEAD") ?? "").trim() || null;
const gitBranch =
  (process.env.VITE_BUILD_GIT_BRANCH ?? process.env.GITHUB_REF_NAME ?? readGitValue("git rev-parse --abbrev-ref HEAD") ?? "").trim() ||
  null;
const builtAt =
  (process.env.VITE_BUILD_TIMESTAMP ?? process.env.BUILD_TIMESTAMP ?? new Date().toISOString()).trim();
const releaseId =
  (process.env.VITE_BUILD_RELEASE_ID ??
    process.env.GITHUB_RUN_ID ??
    process.env.CF_PAGES_COMMIT_SHA ??
    gitCommitShort ??
    packageVersion).trim();
const isCapacitorBundleBuild = (process.env.CAPACITOR_FRONTEND_ENV ?? "").trim().length > 0;
const frontendPackageRoot = fileURLToPath(new URL(".", import.meta.url));

function assertNoClientServiceRoleEnv(mode: string): void {
  const loadedEnv = loadEnv(mode, frontendPackageRoot, "");
  const hasClientServiceRole = [...Object.keys(loadedEnv), ...Object.keys(process.env)].some(
    (key) => key.startsWith("VITE_") && key.toUpperCase().includes("SERVICE_ROLE"),
  );
  if (hasClientServiceRole) {
    throw new Error(
      "Vite refuses service-role variables with a client-visible prefix. Use a server-only environment name.",
    );
  }
}

// Dev-only client env (the guest-login credentials and any future VITE_DEV_*)
// must never reach a production bundle: Vite inlines VITE_* values from both
// the process env and .env files, so both sources are checked. Same stance as
// the service-role guard above — fail the build naming the variable, not the
// value.
function assertNoClientDevEnvInProductionBuild(mode: string, command: string): void {
  if (command !== "build" || mode !== "production") {
    return;
  }
  const loadedEnv = loadEnv(mode, frontendPackageRoot, "");
  const devClientKeys = Array.from(
    new Set([...Object.keys(loadedEnv), ...Object.keys(process.env)]),
  )
    .filter((key) => key.startsWith("VITE_DEV_"))
    .sort();
  if (devClientKeys.length > 0) {
    throw new Error(
      `Production builds refuse dev-only client env: unset ${devClientKeys.join(", ")}.`,
    );
  }
}

// The hardcoded dev-guest fallback (AuthProvider.resolveDevGuestCredentials)
// is compile-time gated behind import.meta.env.DEV and relies on minification
// dropping the dead branch. This guard asserts on the ARTIFACT instead of the
// inputs: a canary string surviving into a production chunk fails the build,
// whatever refactor let it through.
const PRODUCTION_BUNDLE_CANARIES = ["playwright@instafy.dev", "Playwright123!"];

function productionBundleCanaryGuardPlugin(): Plugin {
  let enforced = false;
  return {
    name: "instafy:production-bundle-canary-guard",
    apply: "build",
    configResolved(config) {
      enforced = config.mode === "production";
    },
    generateBundle(_options, bundle) {
      if (!enforced) {
        return;
      }
      for (const [fileName, output] of Object.entries(bundle)) {
        const content =
          output.type === "chunk"
            ? output.code
            : typeof output.source === "string"
              ? output.source
              : "";
        for (const canary of PRODUCTION_BUNDLE_CANARIES) {
          if (content.includes(canary)) {
            throw new Error(
              `Production bundle contains the dev-only canary "${canary}" in ${fileName} — a development-only code path leaked past its import.meta.env.DEV gate.`,
            );
          }
        }
      }
    },
  };
}

const frontendFeatureManifestPath = resolveFrontendFeatureManifest({
  packageRoot: frontendPackageRoot,
  configuredManifestPath: process.env[FRONTEND_FEATURE_MANIFEST_ENV],
});
const frontendFeatureApiPath = fileURLToPath(
  new URL("./src/feature-api/index.ts", import.meta.url),
);
const frontendFeatureApiControllerPath = fileURLToPath(
  new URL("./src/feature-api/controller.ts", import.meta.url),
);
const frontendFeatureApiRuntimePath = fileURLToPath(
  new URL("./src/feature-api/runtime.ts", import.meta.url),
);
const frontendFeatureApiRuntimeBridgePath = fileURLToPath(
  new URL("./src/feature-api/runtimeBridge.ts", import.meta.url),
);
const frontendFeatureApiUiPath = fileURLToPath(
  new URL("./src/feature-api/ui.ts", import.meta.url),
);
const frontendFeatureApiVoicePath = fileURLToPath(
  new URL("./src/feature-api/voice.ts", import.meta.url),
);

const instafyBuildInfo = {
  app: "instafy-frontend",
  packageVersion,
  gitCommit,
  gitCommitShort,
  gitBranch,
  builtAt,
  releaseId,
};

/**
 * Dev-only endpoint that hands the app THIS machine's Codex subscription login
 * so local testing does not require re-uploading auth.json after every token
 * refresh (see devServerCodexAuthJson.ts for the client side). It serves live
 * OAuth tokens, so it is guarded like a credential vault, not a convenience:
 *
 *  - OFF by default. It only mounts when INSTAFY_DEV_CODEX_SEED=1 is set, so a
 *    plain `pnpm dev`, a `--host` demo, or a tunnel session never exposes it.
 *  - The connecting SOCKET must be loopback (checked on req.socket, not the
 *    forgeable Host header) — a LAN client reaching a `--host 0.0.0.0` server
 *    is rejected even if it sends `Host: localhost`.
 *  - Fail closed on the Host/Origin headers as defense in depth.
 *  - Serve only (`apply: "serve"`); the middleware does not exist in builds.
 *
 * `INSTAFY_DEV_CODEX_SEED_ENABLED` is defined for the client so the button
 * only renders when the endpoint can actually answer.
 */
const DEV_CODEX_SEED_ENABLED = process.env.INSTAFY_DEV_CODEX_SEED === "1";

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.replace(/^::ffff:/i, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function devCodexAuthJsonPlugin(): Plugin {
  return {
    name: "instafy-dev-codex-auth-json",
    apply: "serve",
    configureServer(server) {
      if (!DEV_CODEX_SEED_ENABLED) {
        return;
      }
      server.middlewares.use("/__instafy-dev/codex-auth-json", (req, res) => {
        const finish = (statusCode: number, body: unknown) => {
          res.statusCode = statusCode;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(body));
        };
        // Primary guard: the real connecting socket must be loopback. This is
        // not spoofable by a header, so it holds even under `--host`.
        if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
          finish(403, { error: "loopback only" });
          return;
        }
        // Defense in depth: forgeable but cheap header checks.
        const host = req.headers.host ?? "";
        if (!isLoopbackHost(host)) {
          finish(403, { error: "loopback only" });
          return;
        }
        const origin = req.headers.origin;
        if (origin) {
          let originHost = "";
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = "";
          }
          if (!originHost || originHost !== host) {
            finish(403, { error: "same-origin only" });
            return;
          }
        }
        if (req.method !== "GET") {
          finish(405, { error: "method not allowed" });
          return;
        }
        try {
          const raw = readFileSync(join(homedir(), ".codex", "auth.json"), "utf8");
          // Reuse the canonical sanitizer so the served shape matches the
          // desktop bridge and the Playwright harness exactly.
          const authJson = sanitizeCodexSubscriptionAuthJson(JSON.parse(raw));
          finish(200, { authJson });
        } catch {
          finish(404, { error: "no usable codex subscription login" });
        }
      });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  assertNoClientServiceRoleEnv(mode);
  assertNoClientDevEnvInProductionBuild(mode, command);
  return {
  plugins: [react(), devCodexAuthJsonPlugin(), productionBundleCanaryGuardPlugin()],
  resolve: {
    alias: [
      {
        find: "virtual:instafy/frontend-feature-manifest",
        replacement: frontendFeatureManifestPath,
      },
      {
        find: /^@instafy\/frontend\/feature-api$/,
        replacement: frontendFeatureApiPath,
      },
      {
        find: /^@instafy\/frontend\/feature-api\/controller$/,
        replacement: frontendFeatureApiControllerPath,
      },
      {
        find: /^@instafy\/frontend\/feature-api\/runtime$/,
        replacement: frontendFeatureApiRuntimePath,
      },
      {
        find: /^@instafy\/frontend\/feature-api\/runtime-bridge$/,
        replacement: frontendFeatureApiRuntimeBridgePath,
      },
      {
        find: /^@instafy\/frontend\/feature-api\/ui$/,
        replacement: frontendFeatureApiUiPath,
      },
      {
        find: /^@instafy\/frontend\/feature-api\/voice$/,
        replacement: frontendFeatureApiVoicePath,
      },
    ],
    dedupe: [
      "@capacitor/core",
      "@instafy/provider-contract",
      "@instafy/sdk",
      "react",
      "react-dom",
      "react-router-dom",
    ],
  },
  define: {
    __INSTAFY_BUILD_INFO__: JSON.stringify(instafyBuildInfo),
    __INSTAFY_NATIVE_OTA_CHANNEL__: JSON.stringify(buildNativeOtaChannelMarker(
      loadEnv(mode, frontendPackageRoot, "VITE_").VITE_OTA_CHANNEL,
    )),
    "import.meta.env.INSTAFY_DEV_CODEX_SEED_ENABLED": JSON.stringify(DEV_CODEX_SEED_ENABLED),
  },
  build: {
    rollupOptions: {
      output: isCapacitorBundleBuild
        ? undefined
        : {
            manualChunks(id) {
              return resolveManualChunk(id);
            },
          },
    },
  },
  server: {
    port: 5173,
    allowedHosts: [".rt.instafy.dev"],
    watch: {
      ignored: [
        "**/tmp/**",
        "**/test-results/**",
        "**/.playwright-artifacts*/**",
        "**/dist/**",
        "**/.codex/**",
        "**/.codex-runtime/**"
      ]
    }
  },
  test: {
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "tests/unit/**/*.{test,spec}.{ts,tsx}",
      "tests/playwright/utils/*.test.ts",
    ],
    globals: true,
    environment: "node"
  }
  };
});
