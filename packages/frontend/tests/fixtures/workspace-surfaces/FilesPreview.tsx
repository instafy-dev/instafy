import { useEffect, useRef } from "react";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { FilesPanel } from "../../../src/screens/studio/components/FilesPanel";
import { useStudioDesktopLayout } from "../../../src/screens/studio/useStudioDesktopLayout";
import { Text } from "../../../src/components/Text";
import { getFilesReviewScenario } from "./filesAdapters";

// Use the installed editor package, avoiding the wrapper's remote CDN loader.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export function FilesPreview() {
  const scenario = getFilesReviewScenario();
  const desktop = useStudioDesktopLayout();
  const didOpenPreview = useRef(false);
  useEffect(() => {
    if (!desktop || didOpenPreview.current) return;
    const frame = requestAnimationFrame(() => {
      didOpenPreview.current = true;
      window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", {
        detail: { projectId: "review-space", path: "README.md", preferPreview: true },
      }));
    });
    return () => cancelAnimationFrame(frame);
  }, [desktop]);

  return <section className="flex h-full min-h-0 flex-col" aria-label="Files workspace" data-testid="review-files-panel">
    {scenario !== "normal" ? <Text variant="caption" tone="muted" className="shrink-0 px-4 py-2" data-testid="review-files-scenario">
      Review scenario: {scenario}. Reload without filesScenario to return to the editable example.
    </Text> : null}
    <div className="min-h-0 flex-1"><FilesPanel previewOwnerId="workspace-surfaces-review" /></div>
  </section>;
}
