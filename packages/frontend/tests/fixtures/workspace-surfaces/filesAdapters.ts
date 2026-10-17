import { useSyncExternalStore } from "react";
import type { CodeWorkspace } from "../../../src/types";
import type { ControllerWorkspaceEntry, ControllerWorkspaceFileContent } from "../../../src/sdk/instafy";

const contents: Record<string, string> = {
  "README.md": "# Project workspace\n\nA small example project for reviewing Files on mobile and desktop.\n\n## Getting started\n\nOpen **docs** to browse the project notes, or use the filter to find a loaded file.\n\n- The explorer keeps its own scroll area.\n- File previews use the available workspace.\n- On mobile, Back returns to the file list.\n\n## Navigation checklist\n\n1. Expand a folder.\n2. Open that folder using its arrow action on desktop, or tap it on mobile.\n3. Return to Root using the breadcrumb.\n\n## Notes\n\nThese files are local preview data. No workspace or backend is changed.\n",
  "docs/guide.md": "# Workspace guide\n\nKeep project context close to the conversation.\n\n## Files and folders\n\nUse the explorer for navigating a project. The filter searches folders that have already loaded.\n\n## Mobile preview\n\nThe back button returns to the same file list.\n",
  "docs/release-checklist.md": "# Release checklist\n\n- Review changes.\n- Check small and large layouts.\n- Verify keyboard navigation.\n",
  "docs/product-navigation-review-with-a-deliberately-long-file-name-for-small-screens.md": "# Long filename review\n\nThe filename stays available without pushing file controls outside a narrow screen.\n",
  "src/App.tsx": "export function App() {\n  return <main>Hello, workspace.</main>;\n}\n",
  "src/styles/theme.css": ":root {\n  color-scheme: light dark;\n}\n",
};
if (new URLSearchParams(window.location.search).get("filesList") === "long") {
  for (let index = 1; index <= 30; index += 1) {
    contents[`docs/note-${String(index).padStart(2, "0")}.md`] = `# Note ${index}\n\nA local note for checking file-list scroll restoration.\n`;
  }
}
const directories = new Set(["", "docs", "src", "src/styles"]);
const normalize = (path = "") => path.replace(/^\/+|\/+$/g, "");
const parent = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const modified = "2026-10-17T08:00:00.000Z";
export type FilesReviewScenario = "normal" | "read-only" | "read-error" | "write-error";
export function getFilesReviewScenario(): FilesReviewScenario {
  const value = new URLSearchParams(window.location.search).get("filesScenario");
  return value === "read-only" || value === "read-error" || value === "write-error" ? value : "normal";
}
export const isFilesReviewReadOnly = () => getFilesReviewScenario() === "read-only";
const failRead = (path: string) => getFilesReviewScenario() === "read-error" && normalize(path) === "docs/guide.md";
let localVersion = 0;

function entry(path: string, kind: "file" | "directory"): ControllerWorkspaceEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind,
    ...(kind === "file" ? {
      size: new TextEncoder().encode(contents[path] ?? "").length,
      mimeType: path.endsWith(".md") ? "text/markdown" : "text/plain",
      modified,
    } : { hasChildren: true }),
  };
}
function list(path = ""): ControllerWorkspaceEntry[] {
  const normalized = normalize(path);
  return [
    ...[...directories].filter(item => item && parent(item) === normalized).map(item => entry(item, "directory")),
    ...Object.keys(contents).filter(item => parent(item) === normalized).map(item => entry(item, "file")),
  ];
}
function read(path: string): ControllerWorkspaceFileContent | null {
  // Match the legacy SDK: failed reads resolve null; the panel owns its error UI.
  if (failRead(path)) return null;
  const normalized = normalize(path);
  if (!(normalized in contents)) return null;
  return {
    path: normalized,
    size: new TextEncoder().encode(contents[normalized]).length,
    mimeType: normalized.endsWith(".md") ? "text/markdown" : "text/plain",
    encoding: "utf-8",
    contentBase64: btoa(Array.from(new TextEncoder().encode(contents[normalized]), byte => String.fromCharCode(byte)).join("")),
    isText: true,
    contentText: contents[normalized],
  };
}
function blockedWrite(): never {
  throw new Error("This review supports local file edits and saves only.");
}

function assertCanSave() {
  if (isFilesReviewReadOnly()) throw new Error("This review space is read-only.");
  if (getFilesReviewScenario() === "write-error") throw new Error("Review scenario: the file could not be saved. Your edits are kept.");
}

/** Data boundary only. FilesPanel, its tree, filtering, and preview are production code. */
export const filesApi = {
  list: async ({ path }: { path?: string }) => list(path),
  listAt: async ({ path }: { path?: string }) => ({ ok: true, entries: list(path) }),
  read: async ({ path }: { path: string }) => read(path),
  readAt: async ({ path }: { path: string }) => {
    const file = read(path);
    return file ? { ok: true, file } : { ok: false, notFound: true, error: { code: "not_found" } };
  },
  getRawUrl: async () => null,
  write: async ({ path, content }: { path: string; content: string }) => {
    assertCanSave();
    const normalized = normalize(path);
    contents[normalized] = content;
    return { ok: true, path: normalized, size: new TextEncoder().encode(content).length };
  },
  delete: async () => blockedWrite(),
};

export const filesControllerExtras = {
  workspace: {
    git: {
      fetchStatus: async () => null,
      // Acknowledges a fixture-only version; no Git or network transport exists here.
      syncToRemote: async () => { assertCanSave(); localVersion += 1; return { ok: true, rev: `review-version-${localVersion}` }; },
    },
    versioning: { noteSignal: () => undefined },
  },
};

function initialWorkspace(): CodeWorkspace {
  return {
    files: [], activeFileId: null, lastPrompt: "", lastGeneratedAt: null,
    summary: "", status: "idle", provider: null, error: null,
    installedDependencies: [], lastAppliedAt: null,
  };
}
let workspace = initialWorkspace();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => workspace;
function updateWorkspace(updater: (current: CodeWorkspace) => CodeWorkspace) {
  const next = updater(workspace);
  if (JSON.stringify(next) === JSON.stringify(workspace)) return;
  workspace = next;
  listeners.forEach(listener => listener());
}
const replaceWorkspace = (next: CodeWorkspace) => updateWorkspace(() => next);
const setActiveFile = (id: string | null) => updateWorkspace(current => ({ ...current, activeFileId: id }));
const updateFileContent = (id: string, value: string) => updateWorkspace(current => ({
  ...current, files: current.files.map(file => file.id === id ? { ...file, modified: value } : file),
}));
const noop = () => undefined;

export function useCode() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    workspace: current, updateWorkspace, replaceWorkspace, setActiveFile, updateFileContent,
    historyLength: 0, futureLength: 0, undo: noop, redo: noop, reset: noop, resetFile: noop,
  };
}
export const useCodeUpdater = () => updateWorkspace;
