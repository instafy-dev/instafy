import { useState } from "react";
import { Dialog, DialogTrigger } from "react-aria-components";
import { InfoCircle, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import type { FileViewerFact } from "./filesViewerFooter";

export function FileDetailsFooter({ status, facts }: {
  status: string | null;
  facts: FileViewerFact[];
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  useNativeBackButtonAction(detailsOpen, () => setDetailsOpen(false));
  const size = facts.find((fact) => fact.label === "Size")?.value;
  if (!status && facts.length === 0) return null;

  return (
    <footer data-testid="files-viewer-footer" className={`flex shrink-0 items-center gap-2 border-t border-slate-200/70 px-4 py-1 ${DARK_DIVIDER_BORDER_CLASS}`}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        {status ? (
          <Text as="span" variant="caption" tone="secondary" role="status" data-testid="files-save-status">
            {status}
          </Text>
        ) : null}
        {size ? (
          <Text as="span" variant="caption" tone="muted" className="whitespace-nowrap" data-testid="files-viewer-size">
            <span className="sr-only">Size: </span>{size}
          </Text>
        ) : null}
      </div>
      {facts.length > 0 ? (
        <DialogTrigger isOpen={detailsOpen} onOpenChange={setDetailsOpen}>
          <Button preset="inline" variant="ghost" tone="muted" className="shrink-0" aria-label="File details" data-testid="files-viewer-details">
            <InfoCircle className="h-4 w-4" aria-hidden />
            Details
          </Button>
          <StudioPopover layout="menu" placement="top end" className="w-80">
            <Dialog aria-label="File details" className="space-y-3 p-2 outline-none">
              {({ close }) => <>
                <div className="flex items-center justify-between gap-2">
                  <Text as="h4" variant="bodyStrong" tone="primary">File details</Text>
                  <IconButton size="sm" variant="ghost" tone="muted" aria-label="Close file details" onPress={close}>
                    <Xmark className="h-4 w-4" aria-hidden />
                  </IconButton>
                </div>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                  {facts.map((fact) => <FileFact key={fact.label} fact={fact} />)}
                </dl>
              </>}
            </Dialog>
          </StudioPopover>
        </DialogTrigger>
      ) : null}
    </footer>
  );
}

function FileFact({ fact }: { fact: FileViewerFact }) {
  return <>
    <Text as="dt" variant="body" tone="muted">{fact.label}</Text>
    <Text as="dd" variant="body" tone="secondary" className="min-w-0 [overflow-wrap:anywhere]">{fact.value}</Text>
  </>;
}
