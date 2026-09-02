import type { ClipboardEvent, KeyboardEvent } from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { EditorState, LexicalEditor } from "lexical";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { Microphone } from "iconoir-react";
import { parseAssistantMentions } from "../assistantMentionUI";
import { AgentMentionNode } from "./AgentMentionNode";
import { $createAssistantMentionNode, AssistantMentionNode } from "./AssistantMentionNode";
import { AssistantMentionsPlugin, type MentionAgentProfile } from "./AssistantMentionsPlugin";
import { formatGhostSuggestionRemainderForDisplay } from "./ghostSuggestionDisplay";
import { SlashCommandsPlugin } from "./SlashCommandsPlugin";
import { UserMentionNode } from "./UserMentionNode";
import { resolveChatInputMaxHeightPx } from "./chatInputGrowth";
import type { ControllerProjectMember } from "../../../../sdk/instafy";
import { installBrowserUseVirtualClipboardForAutomation } from "./browserUseVirtualClipboard";

export type ChatInputHandle = {
  focus: () => void;
  focusAfterValueSync: () => void;
  acceptGhostSuggestion: (remainder: string) => void;
  clear: () => void;
};

type ChatInputProps = {
  draftKey?: string | null;
  value: string;
  editorState: string | null;
  placeholder: string;
  ghostSuggestionRemainder?: string | null;
  agentHandles: string[];
  agentProfiles?: MentionAgentProfile[];
  mentionableUsers?: ControllerProjectMember[];
  onChange: (nextValue: string, editorState: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  recordingIndicatorActive?: boolean;
  recordingIndicatorLabel?: string | null;
  compact?: boolean;
  // Narrow (< sm) viewports cap growth at fewer lines; the composer passes the
  // same JS breakpoint it uses for its own layout so both agree.
  compactViewport?: boolean;
  readOnly?: boolean;
  onReadOnlyKeyDown?: () => void;
};

function applyTextToEditor(text: string) {
  const root = $getRoot();
  root.clear();
  const lines = text.split(/\n/);
  if (lines.length === 0) {
    root.append($createParagraphNode());
    return;
  }
  for (const line of lines) {
    const paragraph = $createParagraphNode();
    const chunks = parseAssistantMentions(line);
    if (chunks.length === 0) {
      root.append(paragraph);
      continue;
    }
    for (const chunk of chunks) {
      if (chunk.type === "text") {
        if (chunk.value.length > 0) {
          paragraph.append($createTextNode(chunk.value));
        }
      } else {
        paragraph.append($createAssistantMentionNode(chunk.value));
      }
    }
    root.append(paragraph);
  }
}

function applySerializedEditorState(editor: LexicalEditor, serializedState: string): boolean {
  try {
    const parsed = editor.parseEditorState(serializedState);
    editor.setEditorState(parsed);
    return true;
  } catch (_error) {
    return false;
  }
}

function ChatInputEditor(
  {
    value,
    editorState,
    draftKey,
    placeholder,
    ghostSuggestionRemainder,
    agentHandles,
    agentProfiles,
    mentionableUsers,
    onChange,
    onKeyDown,
    onPaste,
    recordingIndicatorActive,
    recordingIndicatorLabel,
    compact,
    compactViewport = false,
    readOnly = false,
    onReadOnlyKeyDown,
  }: ChatInputProps,
  ref: React.Ref<ChatInputHandle>
) {
  const [editor] = useLexicalComposerContext();
  const lastValueRef = useRef(value);
  const lastEditorStateRef = useRef<string | null>(editorState ?? null);
  const controlledValueRef = useRef(value ?? "");
  const controlledEditorStateRef = useRef<string | null>(editorState ?? null);
  const lastDraftKeyRef = useRef(draftKey ?? null);
  const pendingLocalChangeRef = useRef<{ value: string; editorState: string } | null>(null);
  const pendingSelectEndAfterSyncRef = useRef(false);
  const showRecordingIndicator = recordingIndicatorActive === true;
  const showGhostSuggestion = !showRecordingIndicator && Boolean(ghostSuggestionRemainder && ghostSuggestionRemainder.length > 0);
  const displayedGhostSuggestionRemainder = showGhostSuggestion
    ? formatGhostSuggestionRemainderForDisplay(ghostSuggestionRemainder ?? "")
    : "";

  useEffect(() => {
    if (import.meta.env.DEV) {
      installBrowserUseVirtualClipboardForAutomation();
    }
  }, []);

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editor.update(() => {
          $getRoot().selectEnd();
        });
        editor.focus();
        // Lexical routes focus() through its async update loop and can no-op
        // on an editor that has never held focus; the DOM fallback guarantees
        // the caret actually lands for programmatic callers.
        const rootElement = editor.getRootElement();
        if (rootElement && document.activeElement !== rootElement) {
          rootElement.focus();
        }
      },
      focusAfterValueSync: () => {
        pendingSelectEndAfterSyncRef.current = true;
      },
      acceptGhostSuggestion: (remainder: string) => {
        if (!remainder) {
          editor.update(() => {
            $getRoot().selectEnd();
          });
          editor.focus();
          return;
        }
        editor.update(() => {
          const root = $getRoot();
          root.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(remainder);
          }
        });
        editor.focus();
      },
      clear: () => {
        lastValueRef.current = "";
        lastEditorStateRef.current = null;
        editor.update(() => applyTextToEditor(""));
      },
    }),
    [editor]
  );

  useEffect(() => {
    const nextValue = value ?? "";
    const nextState = editorState ?? null;
    const nextDraftKey = draftKey ?? null;
    controlledValueRef.current = nextValue;
    controlledEditorStateRef.current = nextState;

    const draftKeyChanged = nextDraftKey !== lastDraftKeyRef.current;
    if (draftKeyChanged) {
      lastDraftKeyRef.current = nextDraftKey;
      pendingLocalChangeRef.current = null;
    } else {
      const pendingLocalChange = pendingLocalChangeRef.current;
      if (pendingLocalChange) {
        const controlledOwnerCaughtUp =
          nextValue === pendingLocalChange.value &&
          (nextState === null || nextState === pendingLocalChange.editorState);
        if (!controlledOwnerCaughtUp) {
          // React may commit an already-started render after Lexical has accepted
          // fresh input but before the conversation owner adopts onChange. That
          // render still carries the previous draft and must not roll the local
          // keystroke back. A draft-key change remains authoritative so switching
          // projects or conversations cannot leak a pending edit across scopes.
          return;
        }
        pendingLocalChangeRef.current = null;
      }
    }

    const stateChanged = nextState !== lastEditorStateRef.current;
    if (stateChanged) {
      if (nextState && !applySerializedEditorState(editor, nextState)) {
        editor.update(() => applyTextToEditor(nextValue));
      } else if (!nextState) {
        editor.update(() => applyTextToEditor(nextValue));
      }
      lastEditorStateRef.current = nextState;
      lastValueRef.current = nextValue;
      if (pendingSelectEndAfterSyncRef.current) {
        pendingSelectEndAfterSyncRef.current = false;
        editor.update(() => {
          $getRoot().selectEnd();
        });
        editor.focus();
      }
      return;
    }
    if (nextValue !== lastValueRef.current) {
      editor.update(() => applyTextToEditor(nextValue));
      lastValueRef.current = nextValue;
      if (pendingSelectEndAfterSyncRef.current) {
        pendingSelectEndAfterSyncRef.current = false;
        editor.update(() => {
          $getRoot().selectEnd();
        });
        editor.focus();
      }
    }
  }, [draftKey, editor, editorState, value]);

  const handleChange = useCallback(
    (nextState: EditorState) => {
      const text = nextState.read(() => $getRoot().getTextContent());
      const serialized = JSON.stringify(nextState.toJSON());
      lastValueRef.current = text;
      lastEditorStateRef.current = serialized;
      const matchesControlledState =
        text === controlledValueRef.current &&
        (controlledEditorStateRef.current === null || serialized === controlledEditorStateRef.current);
      pendingLocalChangeRef.current = matchesControlledState
        ? null
        : { value: text, editorState: serialized };
      onChange(text, serialized);
    },
    [onChange]
  );

  return (
    <div className="relative">
      {showGhostSuggestion ? (
        <div
          aria-hidden="true"
          data-testid="chat-input-ghost-suggestion"
          className="pointer-events-none absolute inset-x-0 bottom-0 top-1 z-10 overflow-hidden whitespace-pre-wrap break-words pr-2 text-base leading-5 text-slate-400 sm:top-0.5 sm:text-sm dark:text-slate-600"
        >
          <span className="invisible">{value}</span>
          <span className="opacity-70 dark:opacity-45">{displayedGhostSuggestionRemainder}</span>
        </div>
      ) : null}
      {showRecordingIndicator ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden py-1 text-base leading-5 sm:py-0.5 sm:text-sm"
        >
          {value.length > 0 ? (
            <span className="whitespace-pre-wrap break-words text-transparent">{value}</span>
          ) : null}
          <span
            data-testid="chat-input-recording-indicator"
            title={recordingIndicatorLabel ?? "Recording"}
            className="relative ml-0.5 inline-flex h-5 w-5 translate-y-[1px] items-center justify-center rounded-full border border-primary-300/70 bg-primary-500/10 align-baseline text-primary-600 shadow-[0_0_0_6px_rgba(59,130,246,0.08)] dark:border-primary-400/50 dark:bg-primary-400/10 dark:text-primary-200 dark:shadow-[0_0_0_6px_rgba(96,165,250,0.06)]"
          >
            <span className="absolute inset-0 rounded-full bg-primary-500/20 animate-ping dark:bg-primary-400/20" />
            <Microphone className="relative h-3.5 w-3.5" />
          </span>
        </div>
      ) : null}
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            id="studio-chat-input"
            data-testid="chat-input"
            aria-label="Ask Octo"
            role="textbox"
            aria-multiline="true"
            aria-readonly={readOnly}
            aria-disabled={readOnly || undefined}
            // Use capture phase so Enter-to-send can prevent Lexical's newline insertion first.
            // A read-only editor discards keystrokes silently at the Lexical
            // layer; surface the attempt to the composer instead of eating it.
            onKeyDownCapture={(event) => {
              if (readOnly) {
                onReadOnlyKeyDown?.();
                return;
              }
              onKeyDown?.(event);
            }}
            onPaste={onPaste}
            // The editor is a single line at rest and auto-grows with content
            // until the per-viewport line cap, then scrolls inside. The cap is
            // an inline style so the line count stays the single source of
            // truth (see chatInputGrowth.ts).
            style={compact ? undefined : { maxHeight: `${resolveChatInputMaxHeightPx({ compactViewport })}px` }}
            data-max-height-px={compact ? undefined : resolveChatInputMaxHeightPx({ compactViewport })}
            className={`relative z-0 w-full overflow-auto whitespace-pre-wrap break-words text-base leading-5 text-slate-900 outline-none sm:text-sm dark:text-slate-100 ${
              compact ? "min-h-7 max-h-24 py-0.5" : "min-h-7 py-1 sm:min-h-6 sm:py-0.5"
            } ${readOnly ? "cursor-not-allowed opacity-60" : ""}`}
          />
        }
        placeholder={
          showGhostSuggestion || showRecordingIndicator ? null : (
            <div
              className={`pointer-events-none absolute inset-x-0 top-1 z-10 block overflow-hidden text-ellipsis whitespace-nowrap pr-2 text-base leading-5 text-slate-400 sm:top-0.5 sm:text-sm dark:text-slate-500 ${
                readOnly ? "opacity-60" : ""
              }`}
            >
              {placeholder}
            </div>
          )
        }
        ErrorBoundary={({ children }) => <>{children}</>}
      />
      <OnChangePlugin onChange={handleChange} />
      <HistoryPlugin />
      <AssistantMentionsPlugin
        agentHandles={agentHandles}
        agentProfiles={agentProfiles}
        mentionableUsers={mentionableUsers}
      />
      <SlashCommandsPlugin />
    </div>
  );
}

const ChatInputEditorWithRef = forwardRef(ChatInputEditor);

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    value,
    editorState,
    draftKey,
    placeholder,
    ghostSuggestionRemainder,
    agentHandles,
    agentProfiles,
    mentionableUsers,
    onChange,
    onKeyDown,
    onPaste,
    recordingIndicatorActive,
    recordingIndicatorLabel,
    compact,
    compactViewport,
    readOnly,
    onReadOnlyKeyDown,
  },
  ref
) {
  const initialStateRef = useRef({ value, editorState });
  const initialConfig = useMemo(
    () => ({
      namespace: "instafy-chat-input",
      nodes: [AssistantMentionNode, AgentMentionNode, UserMentionNode],
      onError: (error: Error) => {
        throw error;
      },
      editorState: (editor: LexicalEditor) => {
        const initialValue = initialStateRef.current.value ?? "";
        const initialEditorState = initialStateRef.current.editorState ?? null;
        if (initialEditorState && applySerializedEditorState(editor, initialEditorState)) {
          return;
        }
        editor.update(() => applyTextToEditor(initialValue));
      }
    }),
    []
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <ChatInputEditorWithRef
        ref={ref}
        value={value}
        editorState={editorState}
        draftKey={draftKey}
        placeholder={placeholder}
        ghostSuggestionRemainder={ghostSuggestionRemainder}
        agentHandles={agentHandles}
        agentProfiles={agentProfiles}
        mentionableUsers={mentionableUsers}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        recordingIndicatorActive={recordingIndicatorActive}
        recordingIndicatorLabel={recordingIndicatorLabel}
        compact={compact}
        compactViewport={compactViewport}
        readOnly={readOnly}
        onReadOnlyKeyDown={onReadOnlyKeyDown}
      />
    </LexicalComposer>
  );
});
