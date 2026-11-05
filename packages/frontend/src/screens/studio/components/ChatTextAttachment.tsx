import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Page } from "iconoir-react";
import { Button } from "../../../components/Button";
import { InlineNotice } from "../../../components/InlineNotice";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Text } from "../../../components/Text";
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { downloadChatAttachment } from "../../../lib/chatAttachments";
import { hasSupabaseConfig, supabase } from "../../../lib/supabaseClient";
import { readTextAttachmentPage, TEXT_ATTACHMENT_PAGE_BYTES } from "./textAttachmentPage";

type TextAttachmentState =
  | { status: "loading" }
  | { status: "ready"; blob: Blob }
  | { status: "failed" }
  | { status: "unavailable" };

function TextAttachmentContents({ storagePath, fileName }: { storagePath: string; fileName: string }) {
  const [state, setState] = useState<TextAttachmentState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const result = await downloadChatAttachment(storagePath);
        if (cancelled) return;
        if (!result.ok) {
          setState({ status: result.reason === "transient" ? "failed" : "unavailable" });
          return;
        }
        setState({ status: "ready", blob: result.blob });
      } catch {
        if (!cancelled) setState({ status: "failed" });
      }
    })();
    return () => { cancelled = true; };
  }, [storagePath, attempt]);

  if (state.status === "ready") return <TextAttachmentPreview blob={state.blob} fileName={fileName} />;
  if (state.status === "loading") return <StudioDialogBody><LoadingStatus>Loading attachment…</LoadingStatus></StudioDialogBody>;
  if (state.status === "unavailable") {
    return <StudioDialogBody><InlineNotice appearance="inline" role="status">This attachment is unavailable.</InlineNotice></StudioDialogBody>;
  }
  if (state.status === "failed") {
    return (
      <StudioDialogBody><InlineNotice
        appearance="inline"
        tone="danger"
        role="alert"
        actions={<Button preset="inline" onPress={(event) => {
          event.target.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
          setAttempt((value) => value + 1);
        }}>Try again</Button>}
      >
        Couldn't load attachment. Check your connection and try again.
      </InlineNotice></StudioDialogBody>
    );
  }
}

function TextAttachmentPreview({ blob, fileName }: { blob: Blob; fileName: string }) {
  const [offsets, setOffsets] = useState([0]);
  const [pageIndex, setPageIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loadedPage, setLoadedPage] = useState<{ offset: number; content: string; nextOffset: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<"previous" | "next" | null>(null);
  const offset = offsets[pageIndex];
  const page = loadedPage?.offset === offset ? loadedPage : null;
  const previousUnavailable = !page || pageIndex === 0;
  const nextUnavailable = !page || page.nextOffset === null;
  const canDownload = !Capacitor.isNativePlatform();
  const paginated = blob.size > TEXT_ATTACHMENT_PAGE_BYTES;
  useEffect(() => {
    let cancelled = false;
    setLoadedPage(null);
    setFailed(false);
    void readTextAttachmentPage(blob, offset).then((result) => {
      if (!cancelled) {
        setLoadedPage({ ...result, offset });
        setPendingNavigation(null);
      }
    }).catch(() => {
      if (!cancelled) {
        setFailed(true);
        setPendingNavigation(null);
      }
    });
    return () => { cancelled = true; };
  }, [blob, offset, attempt]);
  return (
    <>
      <StudioDialogBody key={pageIndex} scrollable>
        {failed ? <InlineNotice appearance="inline" tone="danger" role="alert" actions={
          <Button preset="inline" onPress={(event) => {
            event.target.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
            setAttempt((value) => value + 1);
          }}>Try again</Button>
        }>Couldn't read this page.</InlineNotice> : !page ? <LoadingStatus>Loading attachment…</LoadingStatus> :
          page.content.length === 0 ? <Text tone="muted">This file is empty.</Text> : (
            <Text as="pre" variant="mono" data-testid="chat-file-attachment-content" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {page.content}
            </Text>
          )}
      </StudioDialogBody>
      {paginated || canDownload ? <StudioDialogFooter padding="default" divider className="flex flex-wrap items-center gap-2">
        {paginated ? <>
          <Button preset="inline" variant="ghost" tone={previousUnavailable ? "muted" : "neutral"} aria-disabled={previousUnavailable}
            isPending={pendingNavigation === "previous"} onPress={() => {
              if (!page || pageIndex === 0) return;
              setPendingNavigation("previous");
              setPageIndex((value) => value - 1);
            }}>Previous</Button>
          <Text as="span" variant="caption" tone="muted" role="status">Page {pageIndex + 1}</Text>
          <Button preset="inline" variant="ghost" tone={nextUnavailable ? "muted" : "neutral"} aria-disabled={nextUnavailable}
            isPending={pendingNavigation === "next"} onPress={() => {
            const nextOffset = page?.nextOffset;
            if (nextOffset == null) return;
            setPendingNavigation("next");
            setOffsets((values) => [...values.slice(0, pageIndex + 1), nextOffset]);
            setPageIndex((value) => value + 1);
          }}>Next</Button>
        </> : null}
        {canDownload ? (
          <Button preset="inline" variant="ghost" onPress={() => {
            const url = URL.createObjectURL(new Blob([blob], { type: "text/plain" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
          }}>Download file</Button>
        ) : null}
      </StudioDialogFooter> : null}
    </>
  );
}

/** Private text stays in the current reading session and is never rendered as HTML. */
export function ChatTextAttachment({ storagePath, fileName }: { storagePath: string; fileName: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !hasSupabaseConfig) return;
    let userId: string | null | undefined;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const nextUserId = session?.user.id ?? null;
      if (event === "SIGNED_OUT" || (userId !== undefined && userId !== nextUserId)) setOpen(false);
      userId = nextUserId;
    });
    return () => data.subscription.unsubscribe();
  }, [open]);
  return (
    <>
      <Button
        preset="inline"
        variant="secondary"
        onPress={(event) => {
          if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true });
          setOpen(true);
        }}
        aria-label={`Open ${fileName}`}
        title={fileName}
        className="max-w-full"
        data-testid="chat-file-attachment"
      >
        <Page className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{fileName}</span>
      </Button>
      <StudioDialogModal isOpen={open} onOpenChange={setOpen} isDismissable size="lg" layout="editor" gutter="responsive" dialogAriaLabel={fileName}>
        <StudioDialogHeader title={fileName} onClose={() => setOpen(false)} closeLabel="Close attachment" />
        {open ? <TextAttachmentContents key={storagePath} storagePath={storagePath} fileName={fileName} /> : null}
      </StudioDialogModal>
    </>
  );
}
