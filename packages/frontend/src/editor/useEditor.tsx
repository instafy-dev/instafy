export function useEditor() {
  return {
    lintFile: async () => {
      console.warn("Editor linting is not implemented in this build.");
    },
    formatFile: async () => {
      console.warn("Editor formatting is not implemented in this build.");
    }
  } as const;
}
