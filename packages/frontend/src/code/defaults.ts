import type { CodeFile, CodeWorkspace } from "../types";

// Default code files are currently empty; seed files can be provided later when
// we introduce built-in templates again.
const defaultFiles: CodeFile[] = [];

export function cloneCodeWorkspace(workspace: CodeWorkspace): CodeWorkspace {
  return JSON.parse(JSON.stringify(workspace)) as CodeWorkspace;
}

export function createDefaultCodeWorkspace(seedFiles: CodeFile[] = defaultFiles): CodeWorkspace {
  const files = seedFiles.map((file) => ({ ...file }));
  return {
    files,
    activeFileId: files[0]?.id ?? null,
    lastPrompt: "",
    lastGeneratedAt: null,
    summary: "",
    status: "idle",
    provider: null,
    error: null,
    installedDependencies: [],
    lastAppliedAt: null
  };
}

export const DEFAULT_CODE_FILES = defaultFiles;
