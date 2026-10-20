import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ConversationSitePreviewView } from "../../../workspace/conversationSurfaces";
import { NO_MOUNTED_SITE_PREVIEWS, SitePreviewPane, nextMountedSitePreviews, type MountedSitePreviews } from "./SitePreviewPane";

/**
 * The tab panel that holds one conversation's site preview panes.
 *
 * A pane mounts the first time its preview is on screen and stays mounted while
 * its tab is open, so moving between views does not reload the site; only the
 * pane on screen is `visible`, so hidden panes send no heartbeats or health
 * polls. Closing the tab, or moving to another conversation (`scope`), unmounts
 * the pane, which revokes its viewer session.
 */
export function SitePreviewPanel({ id, label, projectId, scope, previews, visiblePreviewId, style }: {
  /** The id the preview tabs name in `aria-controls`. */
  id: string;
  label: string;
  projectId: string;
  scope: string | null;
  previews: readonly ConversationSitePreviewView[];
  visiblePreviewId: string | null;
  style?: CSSProperties;
}) {
  const previewIds = useMemo(() => previews.map(preview => preview.previewId), [previews]);
  const [mounted, setMounted] = useState<MountedSitePreviews>(NO_MOUNTED_SITE_PREVIEWS);
  const next = nextMountedSitePreviews(mounted, scope, previewIds, visiblePreviewId);
  useEffect(() => {
    if (next !== mounted) setMounted(next);
  }, [mounted, next]);

  return (
    <div id={id} role="tabpanel" aria-label={label} hidden={!visiblePreviewId} className={visiblePreviewId ? "h-full min-h-0" : "hidden"}
      style={style} data-testid="site-preview-panel">
      {previews.filter(preview => next.ids.includes(preview.previewId)).map(preview => {
        const shown = preview.previewId === visiblePreviewId;
        return (
          <div key={`${scope}:${preview.previewId}`} className={shown ? "h-full min-h-0" : "hidden"} hidden={!shown} data-testid="site-preview-slot">
            <SitePreviewPane projectId={projectId} previewId={preview.previewId} title={preview.title} visible={shown} />
          </div>
        );
      })}
    </div>
  );
}
