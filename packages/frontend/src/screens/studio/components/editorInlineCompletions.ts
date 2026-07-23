import type { Monaco } from "@monaco-editor/react";

import { controllerClient } from "../../../sdk/instafy";

const { requestProjectEditorInline: requestProjectEditorInlineCompletion } = controllerClient.completions;

const INLINE_COMPLETION_PREFIX_WINDOW = 6000;
const INLINE_COMPLETION_SUFFIX_WINDOW = 2000;
const INLINE_COMPLETION_DEBOUNCE_MS = 120;

const INLINE_COMPLETION_LANGUAGES = [
  "plaintext",
  "markdown",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "json",
  "css",
  "scss",
  "less",
  "html",
  "yaml",
  "sql",
  "python",
  "rust",
  "go",
  "java",
  "kotlin",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "perl",
  "lua",
  "objective-c",
  "swift",
  "shell",
  "powershell",
  "graphql",
  "xml",
  "ini",
  "dockerfile",
] as const;

type InlineCompletionModel = {
  getLanguageId: () => string;
  getOffsetAt: (position: { lineNumber: number; column: number }) => number;
  getValue: () => string;
  getVersionId: () => number;
  uri?: { path?: string | null };
};

type InlineCompletionPosition = {
  column: number;
  lineNumber: number;
};

type InlineCompletionCancellation = {
  isCancellationRequested?: boolean;
  onCancellationRequested?: (listener: () => void) => { dispose?: () => void };
};

type InlineCompletionResult = {
  completion: string | null;
  success: boolean;
};

export interface EditorInlineCompletionContext {
  prefix: string;
  suffix: string;
}

interface RegisterProxyInlineCompletionProvidersOptions {
  getProjectId: () => string | null;
  getCredentialId?: () => string | null;
  getFilePath?: (model: InlineCompletionModel) => string | null;
}

function waitForDebounce(
  token: InlineCompletionCancellation | undefined,
  durationMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const cancellation = token?.onCancellationRequested?.(() => {
      globalThis.clearTimeout(timeoutHandle);
      cancellation?.dispose?.();
      resolve(false);
    });
    const timeoutHandle = globalThis.setTimeout(() => {
      cancellation?.dispose?.();
      resolve(true);
    }, durationMs);
  });
}

export function normalizeInlineCompletionPath(path: string | null | undefined): string | null {
  if (typeof path !== "string") {
    return null;
  }
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : null;
}

export function sliceEditorInlineCompletionContext(
  documentText: string,
  cursorOffset: number,
): EditorInlineCompletionContext {
  const normalizedText = documentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const boundedOffset = Math.max(0, Math.min(cursorOffset, normalizedText.length));
  return {
    prefix: normalizedText.slice(Math.max(0, boundedOffset - INLINE_COMPLETION_PREFIX_WINDOW), boundedOffset),
    suffix: normalizedText.slice(boundedOffset, boundedOffset + INLINE_COMPLETION_SUFFIX_WINDOW),
  };
}

export function shouldRequestInlineCompletion(params: {
  path: string | null;
  projectId: string | null;
  prefix: string;
  suffix: string;
}): boolean {
  if (!params.projectId || !params.path) {
    return false;
  }

  if (params.prefix.length === 0 && params.suffix.length === 0) {
    return false;
  }

  const visibleNeighborhood = `${params.prefix.slice(-160)}${params.suffix.slice(0, 80)}`;
  return visibleNeighborhood.trim().length > 0;
}

function buildCompletionItems(
  monaco: Monaco,
  position: InlineCompletionPosition,
  completion: string | null,
) {
  if (!completion) {
    return { items: [] };
  }
  return {
    items: [
      {
        insertText: completion,
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        ),
      },
    ],
  };
}

export function registerProxyInlineCompletionProviders(
  monaco: Monaco,
  options: RegisterProxyInlineCompletionProvidersOptions,
): () => void {
  let lastResolved: { completion: string | null; key: string } | null = null;
  let inFlight:
    | {
        abortController: AbortController | null;
        key: string;
        promise: Promise<InlineCompletionResult>;
      }
    | null = null;

  const createProvider = () =>
    ({
      disposeInlineCompletions: () => {},
      // Monaco's bundled runtime still calls the legacy cleanup hook in some paths.
      freeInlineCompletions: () => {},
      provideInlineCompletions: async (
        model: InlineCompletionModel,
        position: InlineCompletionPosition,
        _context: unknown,
        token: InlineCompletionCancellation,
      ) => {
        const projectId = options.getProjectId()?.trim() ?? null;
        const path = normalizeInlineCompletionPath(
          options.getFilePath?.(model) ?? model.uri?.path ?? null,
        );
        const documentText = model.getValue();
        const cursorOffset = model.getOffsetAt(position);
        const context = sliceEditorInlineCompletionContext(documentText, cursorOffset);

        if (
          !shouldRequestInlineCompletion({
            path,
            projectId,
            prefix: context.prefix,
            suffix: context.suffix,
          })
        ) {
          return { items: [] };
        }
        const requestProjectId = projectId;
        const requestPath = path;
        if (!requestProjectId || !requestPath) {
          return { items: [] };
        }

        const requestKey = JSON.stringify([
          requestProjectId,
          requestPath,
          model.getLanguageId(),
          model.getVersionId(),
          cursorOffset,
        ]);
        if (lastResolved?.key === requestKey) {
          return buildCompletionItems(monaco, position, lastResolved.completion);
        }

        if (!inFlight || inFlight.key !== requestKey) {
          inFlight?.abortController?.abort();
          const abortController =
            typeof AbortController === "function" ? new AbortController() : null;
          const cancellation = token.onCancellationRequested?.(() => {
            abortController?.abort();
          });
          const promise = (async (): Promise<InlineCompletionResult> => {
            const shouldContinue = await waitForDebounce(token, INLINE_COMPLETION_DEBOUNCE_MS);
            if (!shouldContinue) {
              return { success: false, completion: null };
            }

            const result = await requestProjectEditorInlineCompletion({
              projectId: requestProjectId,
              path: requestPath,
              prefix: context.prefix,
              suffix: context.suffix,
              language: model.getLanguageId(),
              credentialId: options.getCredentialId?.() ?? null,
              signal: abortController?.signal,
            });

            if (!result.success || !result.completion) {
              return { success: result.success, completion: null };
            }
            return { success: true, completion: result.completion };
          })().finally(() => {
            cancellation?.dispose?.();
            if (inFlight?.key === requestKey) {
              inFlight = null;
            }
          });

          inFlight = {
            abortController,
            key: requestKey,
            promise,
          };
        }

        const resolved = await inFlight.promise;
        if (token.isCancellationRequested) {
          return { items: [] };
        }

        lastResolved = {
          completion: resolved.completion,
          key: requestKey,
        };

        return buildCompletionItems(monaco, position, resolved.completion);
      },
    }) as {
      disposeInlineCompletions: (completions: unknown) => void;
      freeInlineCompletions: (completions: unknown) => void;
      provideInlineCompletions: (
        model: InlineCompletionModel,
        position: InlineCompletionPosition,
        context: unknown,
        token: InlineCompletionCancellation,
      ) => Promise<{ items: { insertText: string; range: unknown }[] }>;
    };

  const disposables = INLINE_COMPLETION_LANGUAGES.map((language) =>
    monaco.languages.registerInlineCompletionsProvider(language, createProvider() as never),
  );

  return () => {
    inFlight?.abortController?.abort();
    inFlight = null;
    lastResolved = null;
    for (const disposable of disposables) {
      disposable.dispose();
    }
  };
}
