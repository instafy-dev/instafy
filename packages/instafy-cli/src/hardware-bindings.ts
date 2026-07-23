import fs from "node:fs";
import path from "node:path";
import kleur from "kleur";
import { findProjectManifest } from "./project-manifest.js";
import type {
  LocalHardwareBinding,
  LocalHardwareBindingStore,
  LocalHardwareCapability,
  LocalHardwareResourceGrant,
} from "@instafy/sdk/hardware-provider";

const SERIAL_HARDWARE_PROVIDER_ID = "hardware.serial";
const DEFAULT_SERIAL_CAPABILITIES: LocalHardwareCapability[] = [
  "hardware_serial_list",
  "hardware_serial_probe",
];
const SUPPORTED_HARDWARE_CAPABILITIES = new Set<LocalHardwareCapability>(
  DEFAULT_SERIAL_CAPABILITIES,
);

interface ResolveHardwareBindingContext {
  bindingsPath: string;
  projectId: string;
}

export interface HardwareBindingShowOptions {
  providerId?: string | null;
  path?: string;
  json?: boolean;
}

export interface HardwareBindingGrantOptions {
  providerId: string;
  path?: string;
  capabilities?: string[];
  devices?: string[];
  purpose?: string | null;
  json?: boolean;
}

export interface HardwareBindingRevokeOptions {
  providerId: string;
  path?: string;
  json?: boolean;
}

function resolveHardwareBindingContext(startDir: string): ResolveHardwareBindingContext {
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
  return {
    bindingsPath: path.join(instafyDir, "hardware-bindings.json"),
    projectId,
  };
}

function readHardwareBindingStore(bindingsPath: string): LocalHardwareBindingStore {
  if (!fs.existsSync(bindingsPath)) {
    return { version: 1, bindings: {} };
  }
  const raw = JSON.parse(fs.readFileSync(bindingsPath, "utf8")) as Partial<LocalHardwareBindingStore>;
  const bindings =
    raw && typeof raw.bindings === "object" && raw.bindings !== null ? raw.bindings : {};
  return {
    version: 1,
    bindings: bindings as Record<string, LocalHardwareBinding>,
  };
}

function writeHardwareBindingStore(
  bindingsPath: string,
  store: LocalHardwareBindingStore,
) {
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
  fs.writeFileSync(bindingsPath, JSON.stringify(store, null, 2), "utf8");
}

function normalizeCapabilities(
  providerId: string,
  values?: string[],
): LocalHardwareCapability[] {
  const requested =
    Array.isArray(values) && values.length > 0
      ? values
      : providerId === SERIAL_HARDWARE_PROVIDER_ID
        ? DEFAULT_SERIAL_CAPABILITIES
        : [];
  const unique = new Set<LocalHardwareCapability>();
  for (const value of requested) {
    const trimmed = String(value).trim();
    if (!SUPPORTED_HARDWARE_CAPABILITIES.has(trimmed as LocalHardwareCapability)) {
      throw new Error(
        `Unsupported hardware capability: ${trimmed}. Expected ${[
          ...SUPPORTED_HARDWARE_CAPABILITIES,
        ].join(" or ")}.`,
      );
    }
    unique.add(trimmed as LocalHardwareCapability);
  }
  if (unique.size === 0) {
    throw new Error(`No default hardware capabilities are known for ${providerId}.`);
  }
  return [...unique];
}

function normalizeDevices(values?: string[]): LocalHardwareResourceGrant[] {
  const unique = new Map<string, LocalHardwareResourceGrant>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    unique.set(resolved, {
      kind: "serial_device",
      id: resolved,
      path: resolved,
      displayName: path.basename(resolved),
    });
  }
  return [...unique.values()];
}

function printHardwareBinding(record: LocalHardwareBinding) {
  console.log(kleur.cyan(`Hardware provider: ${record.providerId}`));
  console.log(`Status: ${record.status}`);
  console.log(`Project: ${record.projectId}`);
  console.log(`Capabilities: ${record.grantedCapabilities.join(", ") || "(none)"}`);
  if (record.grantedResources.length > 0) {
    console.log("Resources:");
    for (const resource of record.grantedResources) {
      if (resource.kind === "serial_device") {
        console.log(`- serial device ${resource.path}`);
      }
    }
  }
  if (record.purpose) {
    console.log(`Purpose: ${record.purpose}`);
  }
  console.log(`Updated: ${record.updatedAt}`);
}

export function showHardwareBinding(options: HardwareBindingShowOptions) {
  const context = resolveHardwareBindingContext(options.path ?? process.cwd());
  const store = readHardwareBindingStore(context.bindingsPath);
  const providerId = options.providerId?.trim() || null;

  if (providerId) {
    const record = store.bindings[providerId];
    if (!record) {
      throw new Error(`No hardware binding recorded for ${providerId}.`);
    }
    if (options.json) {
      console.log(JSON.stringify(record));
      return;
    }
    printHardwareBinding(record);
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
    console.log(kleur.yellow("No hardware bindings recorded for this space."));
    return;
  }

  console.log(kleur.cyan(`Hardware bindings for ${context.projectId}:`));
  for (const record of bindings) {
    console.log(`- ${record.providerId} (${record.status})`);
  }
}

export function grantHardwareBinding(options: HardwareBindingGrantOptions) {
  const providerId = options.providerId.trim();
  if (!providerId) {
    throw new Error("Hardware provider id is required.");
  }
  if (providerId !== SERIAL_HARDWARE_PROVIDER_ID) {
    throw new Error(`Unsupported hardware provider: ${providerId}.`);
  }

  const context = resolveHardwareBindingContext(options.path ?? process.cwd());
  const store = readHardwareBindingStore(context.bindingsPath);
  const now = new Date().toISOString();
  const previous = store.bindings[providerId];

  const record: LocalHardwareBinding = {
    providerId,
    projectId: context.projectId,
    grantedCapabilities: normalizeCapabilities(providerId, options.capabilities),
    grantedResources: normalizeDevices(options.devices),
    purpose: options.purpose?.trim() || null,
    status: "bound",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  store.bindings[providerId] = record;
  writeHardwareBindingStore(context.bindingsPath, store);

  if (options.json) {
    console.log(JSON.stringify(record));
    return;
  }

  console.log(kleur.green(`Hardware binding granted: ${providerId}`));
  printHardwareBinding(record);
  console.log(kleur.cyan(`Stored at ${context.bindingsPath}`));
}

export function revokeHardwareBinding(options: HardwareBindingRevokeOptions) {
  const providerId = options.providerId.trim();
  if (!providerId) {
    throw new Error("Hardware provider id is required.");
  }

  const context = resolveHardwareBindingContext(options.path ?? process.cwd());
  const store = readHardwareBindingStore(context.bindingsPath);
  const existing = store.bindings[providerId];
  if (!existing) {
    throw new Error(`No hardware binding recorded for ${providerId}.`);
  }

  delete store.bindings[providerId];
  writeHardwareBindingStore(context.bindingsPath, store);

  if (options.json) {
    console.log(JSON.stringify({ revoked: true, providerId }));
    return;
  }

  console.log(kleur.green(`Hardware binding revoked: ${providerId}`));
  console.log(kleur.cyan(`Updated ${context.bindingsPath}`));
}
