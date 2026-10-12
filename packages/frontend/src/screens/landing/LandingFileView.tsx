import { CloudUpload, Eye, Redo, Undo } from "iconoir-react";
import * as chrome from "./landingStudioChrome";
import type { CodeLine, PaneFile } from "./landingTurnScript";

// A workspace file open beside the chat: FilesPanel embedded in the
// conversation's resource pane (ChatPanel.tsx:5961), its header controls and
// the Monaco editor in the studio's themes. A .csv is plaintext with line
// numbers (there is no table preview), TypeScript is highlighted, and Markdown
// opens in the editor (its preview is a toggle, edit by default) without line
// numbers. A clicked reference or file-change range is selected
// (useFilesPanelViewerState.ts:328-352): the selection colour runs across the
// selected text, and the last selected line's number is the active one.

function LineText({ line }: { line: CodeLine }) {
  if (typeof line === "string") return <>{line}</>;
  return (
    <>
      {line.map((token, index) => (
        <span key={index} className={chrome.EDITOR_TOKEN[token.kind] || undefined}>
          {token.text}
        </span>
      ))}
    </>
  );
}

export function LandingFileView({ file, select }: { file: PaneFile; select: readonly [number, number] | null }) {
  const numbered = file.language !== "markdown";
  return (
    <div aria-hidden="true" data-testid="landing-file-view" data-file-path={file.path} className="flex min-h-0 flex-1 flex-col">
      <div className={chrome.FILE_HEADER}>
        <span className={chrome.FILE_HEADER_HISTORY}>
          <Undo className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className={chrome.FILE_HEADER_HISTORY}>
          <Redo className="h-4 w-4" aria-hidden="true" />
        </span>
        {file.language === "markdown" ? (
          <span className={chrome.FILE_HEADER_PREVIEW}>
            <Eye className="h-4 w-4" aria-hidden="true" />
            Preview
          </span>
        ) : null}
        <span className={chrome.FILE_HEADER_SAVE}>
          <CloudUpload className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
      <div className={chrome.EDITOR}>
        {file.lines.map((line, index) => {
          const number = index + 1;
          const selected = !!select && number >= select[0] && number <= select[1];
          // Monaco carries a selection that goes on to the next line a little
          // past the line's end.
          const runsOn = selected && number < select![1];
          return (
            <div key={number} className={chrome.EDITOR_LINE} data-line={number} data-selected={selected ? "true" : undefined}>
              {numbered ? (
                <span className={`${chrome.EDITOR_GUTTER}${select && number === select[1] ? ` ${chrome.EDITOR_GUTTER_ACTIVE}` : ""}`}>{number}</span>
              ) : (
                <span className={chrome.EDITOR_GUTTER_NONE} />
              )}
              <span className={selected ? chrome.EDITOR_SELECTION : undefined}>
                <LineText line={line} />
                {runsOn ? " " : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
