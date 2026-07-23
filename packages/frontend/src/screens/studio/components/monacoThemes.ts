import type { Monaco } from "@monaco-editor/react";

export const STUDIO_MONACO_LIGHT_THEME = "vscode-light-modern";
export const STUDIO_MONACO_DARK_THEME = "vscode-dark-modern";

let themesRegistered = false;

export function ensureStudioMonacoThemes(monaco: Monaco | null): void {
  if (!monaco?.editor || themesRegistered) {
    return;
  }

  themesRegistered = true;

  monaco.editor.defineTheme(STUDIO_MONACO_LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "008000" },
      { token: "keyword", foreground: "0000ff" },
      { token: "number", foreground: "098658" },
      { token: "string", foreground: "a31515" },
      { token: "type", foreground: "267f99" },
      { token: "function", foreground: "795e26" },
      { token: "variable", foreground: "001080" }
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1f2328",
      "editorLineNumber.foreground": "#8c959f",
      "editorLineNumber.activeForeground": "#24292f",
      "editorCursor.foreground": "#0969da",
      "editor.selectionBackground": "#add6ff",
      "editor.inactiveSelectionBackground": "#e5ebf1",
      "editor.lineHighlightBackground": "#f6f8fa",
      "editorIndentGuide.background": "#d0d7de",
      "editorIndentGuide.activeBackground": "#8c959f",
      "editorWhitespace.foreground": "#d0d7de"
    }
  });

  monaco.editor.defineTheme(STUDIO_MONACO_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6a9955" },
      { token: "keyword", foreground: "569cd6" },
      { token: "number", foreground: "b5cea8" },
      { token: "string", foreground: "ce9178" },
      { token: "type", foreground: "4ec9b0" },
      { token: "function", foreground: "dcdcaa" },
      { token: "variable", foreground: "9cdcfe" }
    ],
    colors: {
      "editor.background": "#1f1f1f",
      "editor.foreground": "#d4d4d4",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#c6c6c6",
      "editorCursor.foreground": "#aeafad",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#3a3d41",
      "editor.lineHighlightBackground": "#2a2d2e",
      "editorIndentGuide.background": "#404040",
      "editorIndentGuide.activeBackground": "#707070",
      "editorWhitespace.foreground": "#404040"
    }
  });
}

