import fs from "node:fs";
import path from "node:path";
import { requestControllerApiJson } from "./api.js";
import { findProjectManifest } from "./project-manifest.js";

type CommonOptions = {
  project?: string;
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
};

type Evidence = { conversationId: string; messageId?: string };
type Proposal = { key: string; title: string; reason: string; prompt: string; message?: string; evidence: Evidence[] };
type Recommendation = Proposal & {
  id: string;
  projectId: string;
  status: "proposed" | "accepted" | "dismissed";
  acceptedConversationId: string | null;
  delivered?: boolean;
  deliveredConversationId?: string | null;
  createdAt: string;
  updatedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 65_536;

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value.trim();
}

function projectId(explicit?: string): string {
  const value = explicit ?? process.env["SPACE_ID"] ?? process.env["INSTAFY_SPACE_ID"] ??
    process.env["PROJECT_ID"] ?? process.env["INSTAFY_PROJECT_ID"] ??
    findProjectManifest(process.cwd()).manifest?.spaceId;
  if (!value?.trim()) throw new Error("No space configured. Pass --space, set SPACE_ID, or run `instafy space init`.");
  return uuid(value, "Space ID");
}

function object(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) throw new Error(`${label} contains an unsupported field.`);
  return record;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > max) {
    throw new Error(`${label} must contain 1–${max} characters.`);
  }
  return value.trim();
}

function readProposalFile(file: string): Buffer {
  const manifestPath = findProjectManifest(process.cwd()).path;
  const root = fs.realpathSync(manifestPath ? path.dirname(path.dirname(manifestPath)) : process.cwd());
  const selected = path.resolve(file);
  const canonical = path.join(fs.realpathSync(path.dirname(selected)), path.basename(selected));
  const relative = path.relative(root, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Recommendation file must stay inside the active Instafy workspace.");
  }
  const initial = fs.lstatSync(canonical);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("Recommendation file must be a regular file, not a symlink.");
  const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size > MAX_FILE_BYTES) {
      throw new Error(`Recommendation file must be a regular file no larger than ${MAX_FILE_BYTES} bytes.`);
    }
    bytes = fs.readFileSync(descriptor);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`Recommendation file must be ${MAX_FILE_BYTES} bytes or smaller.`);
  } finally {
    fs.closeSync(descriptor);
  }
  return bytes;
}

async function readProposal(file: string): Promise<Proposal> {
  let bytes: Buffer;
  if (file === "-") {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of process.stdin) {
      const chunk = typeof value === "string" ? Buffer.from(value) : value as Buffer;
      length += chunk.length;
      if (length > MAX_FILE_BYTES) throw new Error(`Recommendation input must be ${MAX_FILE_BYTES} bytes or smaller.`);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else {
    bytes = readProposalFile(file);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Recommendation file must contain valid JSON."); }
  const input = object(parsed, ["key", "title", "reason", "prompt", "message", "evidence"], "Recommendation");
  const key = text(input.key, "Recommendation key", 120);
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/.test(key)) throw new Error("Recommendation key must be a lowercase slug using letters, digits, hyphens or underscores.");
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 8) {
    throw new Error("Recommendation evidence must contain 1–8 conversation or message references.");
  }
  return {
    key,
    title: text(input.title, "Recommendation title", 160),
    reason: text(input.reason, "Recommendation reason", 2000),
    prompt: text(input.prompt, "Recommendation prompt", 4000),
    ...(input.message === undefined ? {} : { message: text(input.message, "Recommendation message", 4000) }),
    evidence: input.evidence.map((value) => {
      const entry = object(value, ["conversationId", "messageId"], "Evidence");
      return {
        conversationId: uuid(entry.conversationId, "Evidence conversationId"),
        ...(entry.messageId === undefined ? {} : { messageId: uuid(entry.messageId, "Evidence messageId") }),
      };
    }),
  };
}

export async function recommendationsList(options: CommonOptions & { limit?: number }): Promise<void> {
  const id = projectId(options.project);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be an integer from 1 to 200.");
  const response = await requestControllerApiJson<{ recommendations: Recommendation[] }>({
    method: "GET", path: `/projects/${id}/recommendations`, query: [`limit=${limit}`],
    controllerUrl: options.controllerUrl, accessToken: options.accessToken,
  });
  if (!Array.isArray(response?.recommendations)) throw new Error("Invalid recommendations response from controller.");
  if (options.json) console.log(JSON.stringify(response, null, 2));
  else if (!response.recommendations.length) console.log("No recommendations found.");
  else for (const item of response.recommendations) console.log(`${item.id} [${item.status}${item.delivered ? ", delivered" : ""}] ${item.title}\n  ${item.reason}`);
}

export async function recommendationsSubmit(options: CommonOptions & { file: string }): Promise<void> {
  const id = projectId(options.project);
  const proposal = await readProposal(options.file);
  const response = await requestControllerApiJson<Recommendation>({
    method: "POST", path: `/projects/${id}/recommendations`, jsonBody: proposal,
    controllerUrl: options.controllerUrl, accessToken: options.accessToken,
  });
  if (!response?.id || !["proposed", "accepted", "dismissed"].includes(response.status)) {
    throw new Error("Invalid recommendation response from controller.");
  }
  if (options.json) console.log(JSON.stringify(response, null, 2));
  else if (response.delivered) console.log(`Recommendation ${response.id} [delivered]: ${response.title}`);
  else console.log(`${response.status === "proposed" ? "Saved" : "Kept"} recommendation ${response.id} [${response.status}]: ${response.title}`);
}
