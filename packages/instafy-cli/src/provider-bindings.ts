import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import kleur from "kleur";
import { findProjectManifest } from "./project-manifest.js";

type ProjectContentCapability = "project_content_read" | "project_content_write";
type ProviderProjectBindingStatus = "bound_read_only" | "bound_read_write";

interface ProviderProjectBindingRecord {
  providerId: string;
  projectId: string;
  rootUri: string;
  grantedCapabilities: ProjectContentCapability[];
  grantedPrefix?: string | null;
  purpose?: string | null;
  status: ProviderProjectBindingStatus;
  createdAt: string;
  updatedAt: string;
}

interface ProviderProjectBindingStore {
  version: 1;
  bindings: Record<string, ProviderProjectBindingRecord>;
}

interface ResolveBindingContext {
  bindingsPath: string;
  projectId: string;
  projectRoot: string;
}

export interface ProviderBindingShowOptions {
  providerId?: string | null;
  path?: string;
  json?: boolean;
}

export interface ProviderBindingGrantOptions {
  providerId: string;
  path?: string;
  capabilities?: string[];
  prefix?: string | null;
  purpose?: string | null;
  json?: boolean;
}

export interface ProviderBindingRevokeOptions {
  providerId: string;
  path?: string;
  json?: boolean;
}

function resolveBindingContext(startDir: string): ResolveBindingContext {
  const lookup = findProjectManifest(path.resolve(startDir));
  if (!lookup.manifest || !lookup.path) {
    throw new Error(
      "Linked space manifest required. Run `instafy space init` in this folder or pass --path <dir>.",
    );
  }
  const projectId = lookup.manifest.spaceId?.trim();
  if (!projectId) {
    throw new Error("Linked space manifest is missing a spaceId.");
  }
  const instafyDir = path.dirname(lookup.path);
  const projectRoot = path.dirname(instafyDir);
  return {
    bindingsPath: path.join(instafyDir, "provider-bindings.json"),
    projectId,
    projectRoot,
  };
}

function readBindingStore(bindingsPath: string): ProviderProjectBindingStore {
  if (!fs.existsSync(bindingsPath)) {
    return { version: 1, bindings: {} };
  }
  const raw = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as Partial<ProviderProjectBindingStore>;
  const bindings =
    raw && typeof raw.bindings === "object" && raw.bindings !== null ? raw.bindings : {};
  return {
    version: 1,
    bindings: bindings as Record<string, ProviderProjectBindingRecord>,
  };
}

function writeBindingStore(bindingsPath: string, store: ProviderProjectBindingStore) {
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
  fs.writeFileSync(bindingsPath, JSON.stringify(store, null, 2), "utf8");
}

function normalizeCapabilities(values?: string[]): ProjectContentCapability[] {
  const requested =
    Array.isArray(values) && values.length > 0
      ? values
      : ["project_content_read", "project_content_write"];
  const unique = new Set<ProjectContentCapability>();
  for (const value of requested) {
    const trimmed = String(value).trim();
    if (trimmed !== "project_content_read" && trimmed !== "project_content_write") {
      throw new Error(
        `Unsupported provider capability: ${trimmed}. Expected project_content_read or project_content_write.`,
      );
    }
    unique.add(trimmed);
  }
  return [...unique];
}

function deriveStatus(
  capabilities: ProjectContentCapability[],
): ProviderProjectBindingStatus {
  if (capabilities.includes("project_content_write")) {
    return "bound_read_write";
  }
  return "bound_read_only";
}

function printBinding(record: ProviderProjectBindingRecord) {
  console.log(kleur.cyan(`Provider: ${record.providerId}`));
  console.log(`Status: ${record.status}`);
  console.log(`Project: ${record.projectId}`);
  console.log(`Root URI: ${record.rootUri}`);
  console.log(`Capabilities: ${record.grantedCapabilities.join(", ") || "(none)"}`);
  if (record.grantedPrefix) {
    console.log(`Prefix: ${record.grantedPrefix}`);
  }
  if (record.purpose) {
    console.log(`Purpose: ${record.purpose}`);
  }
  console.log(`Updated: ${record.updatedAt}`);
}

export function showProviderBinding(options: ProviderBindingShowOptions) {
  const context = resolveBindingContext(options.path ?? process.cwd());
  const store = readBindingStore(context.bindingsPath);
  const providerId = options.providerId?.trim() || null;

  if (providerId) {
    const record = store.bindings[providerId];
    if (!record) {
      throw new Error(`No provider binding recorded for ${providerId}.`);
    }
    if (options.json) {
      console.log(JSON.stringify(record));
      return;
    }
    printBinding(record);
    return;
  }

  const bindings = Object.values(store.bindings).sort((left, right) =>
    left.providerId.localeCompare(right.providerId),
  );
  if (options.json) {
    console.log(
      JSON.stringify({
        projectId: context.projectId,
        bindings,
      }),
    );
    return;
  }

  if (bindings.length === 0) {
    console.log(kleur.yellow("No provider bindings recorded for this space."));
    return;
  }

  console.log(kleur.cyan(`Bindings for ${context.projectId}:`));
  for (const record of bindings) {
    console.log(`- ${record.providerId} (${record.status})`);
  }
}

export function grantProviderBinding(options: ProviderBindingGrantOptions) {
  const providerId = options.providerId.trim();
  if (!providerId) {
    throw new Error("Provider id is required.");
  }

  const context = resolveBindingContext(options.path ?? process.cwd());
  const store = readBindingStore(context.bindingsPath);
  const now = new Date().toISOString();
  const capabilities = normalizeCapabilities(options.capabilities);
  const previous = store.bindings[providerId];

  const record: ProviderProjectBindingRecord = {
    providerId,
    projectId: context.projectId,
    rootUri: pathToFileURL(context.projectRoot).toString(),
    grantedCapabilities: capabilities,
    grantedPrefix: options.prefix?.trim() || `.instafy/providers/${providerId}/`,
    purpose: options.purpose?.trim() || null,
    status: deriveStatus(capabilities),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  store.bindings[providerId] = record;
  writeBindingStore(context.bindingsPath, store);

  if (options.json) {
    console.log(JSON.stringify(record));
    return;
  }

  console.log(kleur.green(`Provider binding granted: ${providerId}`));
  printBinding(record);
  console.log(kleur.cyan(`Stored at ${context.bindingsPath}`));
}

export function revokeProviderBinding(options: ProviderBindingRevokeOptions) {
  const providerId = options.providerId.trim();
  if (!providerId) {
    throw new Error("Provider id is required.");
  }

  const context = resolveBindingContext(options.path ?? process.cwd());
  const store = readBindingStore(context.bindingsPath);
  const existing = store.bindings[providerId];
  if (!existing) {
    throw new Error(`No provider binding recorded for ${providerId}.`);
  }

  delete store.bindings[providerId];
  writeBindingStore(context.bindingsPath, store);

  if (options.json) {
    console.log(JSON.stringify({ revoked: true, providerId }));
    return;
  }

  console.log(kleur.green(`Provider binding revoked: ${providerId}`));
  console.log(kleur.cyan(`Updated ${context.bindingsPath}`));
}
