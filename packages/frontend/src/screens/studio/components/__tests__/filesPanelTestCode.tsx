import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { CodeWorkspace } from "../../../../types";
import { createDefaultCodeWorkspace } from "../../../../code/defaults";

/**
 * A small stand-in for the code store in FilesPanel tests: real React state,
 * the same update functions FilesPanel calls, no persistence.
 */
type TestCode = {
  workspace: CodeWorkspace;
  updateWorkspace: (updater: (current: CodeWorkspace) => CodeWorkspace, options?: { recordHistory?: boolean }) => void;
  replaceWorkspace: (next: CodeWorkspace) => void;
  setActiveFile: (fileId: string | null) => void;
  updateFileContent: (fileId: string, value: string) => void;
  undo: () => void;
  redo: () => void;
  historyLength: number;
  futureLength: number;
};

const TestCodeContext = createContext<TestCode | null>(null);

export const testCodeHandle: { current: TestCode | null } = { current: null };

export function TestCodeProvider({ initial, children }: { initial: Partial<CodeWorkspace>; children: ReactNode }) {
  const [workspace, setWorkspace] = useState<CodeWorkspace>(() => ({
    ...createDefaultCodeWorkspace(),
    files: [],
    activeFileId: null,
    ...initial,
  }));
  const updateWorkspace = useCallback((updater: (current: CodeWorkspace) => CodeWorkspace) => {
    setWorkspace((current) => updater(current));
  }, []);
  const value = useMemo<TestCode>(
    () => ({
      workspace,
      updateWorkspace,
      replaceWorkspace: (next) => setWorkspace(next),
      setActiveFile: (fileId) => setWorkspace((current) => ({ ...current, activeFileId: fileId })),
      updateFileContent: (fileId, value) =>
        setWorkspace((current) => ({
          ...current,
          files: current.files.map((file) => (file.id === fileId ? { ...file, modified: value } : file)),
        })),
      undo: () => undefined,
      redo: () => undefined,
      historyLength: 0,
      futureLength: 0,
    }),
    [updateWorkspace, workspace],
  );
  testCodeHandle.current = value;
  return <TestCodeContext.Provider value={value}>{children}</TestCodeContext.Provider>;
}

export function useTestCode(): TestCode {
  const value = useContext(TestCodeContext);
  if (!value) {
    throw new Error("TestCodeProvider is missing");
  }
  return value;
}
