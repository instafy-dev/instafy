import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
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
 * Dev-only endpoint that hands the app this machine's Codex subscription
 * login so local testing does not require re-uploading auth.json after every
 * token refresh (see devServerCodexAuthJson.ts for the client side). Reads
 * the file fresh per request, so the served copy can never go stale. Serve
 * only (`apply: "serve"`), same-origin only: a cross-origin page in the same
 * browser must not be able to read the login through the dev server.
 */
function devCodexAuthJsonPlugin(): Plugin {
  return {
    name: "instafy-dev-codex-auth-json",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__instafy-dev/codex-auth-json", (req, res) => {
        const finish = (statusCode: number, body: unknown) => {
          res.statusCode = statusCode;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(body));
        };
        const origin = req.headers.origin;
        const host = req.headers.host ?? "";
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
          const parsed = JSON.parse(raw) as {
            auth_mode?: unknown;
            last_refresh?: unknown;
            tokens?: {
              id_token?: unknown;
              access_token?: unknown;
              refresh_token?: unknown;
              account_id?: unknown;
            };
          } | null;
          const tokens = parsed?.tokens;
          if (
            !parsed ||
            parsed.auth_mode !== "chatgpt" ||
            typeof tokens?.access_token !== "string" ||
            typeof tokens?.refresh_token !== "string"
          ) {
            finish(404, { error: "no usable codex subscription login" });
            return;
          }
          finish(200, {
            authJson: {
              auth_mode: "chatgpt",
              tokens: {
                id_token: tokens.id_token,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                account_id: tokens.account_id,
              },
              last_refresh: parsed.last_refresh,
            },
          });
        } catch {
          finish(404, { error: "no usable codex subscription login" });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  assertNoClientServiceRoleEnv(mode);
  return {
  plugins: [react(), devCodexAuthJsonPlugin()],
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
