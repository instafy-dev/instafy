import { useState } from "react";
import { Lock, NavArrowRight, WebWindow } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";

/** Said on hover and to screen readers; the lock alone shows it. */
export const PREVIEW_PRIVATE_LABEL = "Only space members can open this";

export type SitePreviewCardStatus = {
  text: string;
  /** a spinner dot (Starting…) */
  busy?: boolean;
  /** more on hover, e.g. the port that does not answer */
  title?: string;
};

export type SitePreviewCardAction = { id: string; label: string; onPress: () => void; testId: string };

export type SitePreviewCardViewProps = {
  title: string;
  /** one line of facts under the title (plain text), or null */
  facts: string | null;
  /**
   * The site's picture: null when it has none (no picture area at all). While its bytes load, `url` is null and the
   * space is kept, so nothing moves when it arrives.
   */
  picture: { url: string | null } | null;
  /** a site that is starting or not answering is dimmed; a stopped one grey */
  pictureTone: "normal" | "dim" | "gray";
  /** who may open it, as the controller recorded it; only `private` is known today */
  visibility: "private" | null;
  /** only when it is not the normal live state */
  status: SitePreviewCardStatus | null;
  /** `data-state` of the status region, for tests and the eval bench */
  state: string;
  wake?: "waking" | "failed";
  /** false: the card does not look or act pressable (no hover lift, default cursor, aria-disabled) */
  pressable: boolean;
  busy: boolean;
  onOpen: () => void;
  followLine: string | null;
  actions: SitePreviewCardAction[];
  pictureRef?: (node: HTMLElement | null) => void;
};

const PICTURE_TONE: Record<SitePreviewCardViewProps["pictureTone"], string> = {
  normal: "opacity-100",
  dim: "opacity-60",
  gray: "opacity-70 grayscale",
};

/** "Stopped · opening restarts it" → "stopped, opening restarts it", for the button's name. */
function spokenStatus(text: string): string {
  const spoken = text.replace(/\s·\s/g, ", ");
  return spoken.charAt(0).toLowerCase() + spoken.slice(1);
}

/**
 * A preview card as a link preview looks: the site's picture on top, its title with a lock and a chevron, one line of
 * facts, and a status line only when the site is not simply live. The whole card is one button that opens the site
 * beside the chat. It never loads the site itself, and holds no address.
 */
export function SitePreviewCardView({
  title,
  facts,
  picture,
  pictureTone,
  visibility,
  status,
  state,
  wake,
  pressable,
  busy,
  onOpen,
  followLine,
  actions,
  pictureRef,
}: SitePreviewCardViewProps) {
  const [pictureShown, setPictureShown] = useState(false);
  const name = `Open ${title}${status ? `, ${spokenStatus(status.text)}` : ""}`;
  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="sm"
      data-testid="preview-ready-card"
      data-pressable={pressable ? "true" : "false"}
      className={[
        "group relative w-[min(100%,20rem)] overflow-hidden text-sm text-slate-700 transition-shadow duration-150 dark:text-slate-200",
        // Keyboard focus on the card's button rings the whole card.
        "has-[[data-preview-card-open]:focus-visible]:ring-2 has-[[data-preview-card-open]:focus-visible]:ring-primary-500/40 has-[[data-preview-card-open]:focus-visible]:ring-offset-2 has-[[data-preview-card-open]:focus-visible]:ring-offset-white dark:has-[[data-preview-card-open]:focus-visible]:ring-offset-[var(--color-studio-dark-canvas)]",
        pressable ? "hover:shadow-md" : "",
      ].filter(Boolean).join(" ")}
    >
      {picture ? (
        <div
          ref={pictureRef}
          className="aspect-[16/10] w-full overflow-hidden border-b border-slate-200/70 bg-slate-100 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]"
          data-testid="preview-card-picture"
          data-tone={pictureTone}
        >
          {picture.url ? (
            <img
              src={picture.url}
              alt=""
              draggable={false}
              onLoad={() => setPictureShown(true)}
              className={[
                "h-full w-full object-cover object-top motion-safe:transition-opacity motion-safe:duration-300",
                // Fades in once its bytes are drawn.
                pictureShown ? PICTURE_TONE[pictureTone] : "opacity-0",
              ].join(" ")}
            />
          ) : null}
        </div>
      ) : null}
      {/* At least 44 px tall with a title alone, the smallest comfortable tap target. */}
      <div className="px-3 py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {picture ? null : (
            <WebWindow className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          )}
          <button
            type="button"
            data-preview-card-open=""
            data-testid="preview-ready-open"
            aria-label={name}
            aria-disabled={pressable ? undefined : "true"}
            aria-busy={busy ? "true" : undefined}
            onClick={pressable ? onOpen : undefined}
            className={[
              "min-w-0 text-left text-sm font-medium text-midnight focus:outline-none dark:text-slate-50",
              // The button's area is the whole card.
              "after:absolute after:inset-0 after:content-['']",
              pressable ? "cursor-pointer" : "cursor-default",
            ].join(" ")}
          >
            <span className="block truncate" title={title}>{title}</span>
          </button>
          {visibility === "private" ? (
            <span
              role="img"
              aria-label={PREVIEW_PRIVATE_LABEL}
              title={PREVIEW_PRIVATE_LABEL}
              className="relative z-10 inline-flex shrink-0 text-slate-400 dark:text-slate-500"
              data-testid="preview-card-private"
            >
              <Lock className="h-3 w-3" aria-hidden="true" />
            </span>
          ) : null}
          {/* The chevron promises a press, so a card that cannot be pressed has none. */}
          {pressable ? (
            <NavArrowRight
              className="ml-auto h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300"
              aria-hidden="true"
              data-testid="preview-card-open-icon"
            />
          ) : null}
        </div>
        {facts ? (
          <Text as="div" variant="caption" tone="muted" className="truncate" title={facts} data-testid="preview-card-facts">
            {facts}
          </Text>
        ) : null}
        {/* Always in the page, so a change is announced; empty while the site is simply live. */}
        <Text
          as="div"
          variant="caption"
          tone="muted"
          role="status"
          aria-live="polite"
          className={status ? "mt-0.5 flex min-w-0 items-start gap-1.5" : undefined}
          title={status?.title}
          data-testid="preview-ready-status"
          data-state={state}
          data-wake={wake}
        >
          {status ? (
            <>
              {status.busy ? (
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-300 motion-safe:animate-pulse dark:bg-slate-600" aria-hidden="true" />
              ) : null}
              {/* Wraps rather than cut: a reason ("only people who can edit this space can start it") is read whole. */}
              <span className="min-w-0 break-words">{status.text}</span>
            </>
          ) : null}
        </Text>
        {followLine ? (
          <Text as="div" variant="caption" className="mt-0.5 truncate font-medium text-violet-700 dark:text-violet-300" data-testid="preview-ready-follow-line">
            {followLine}
          </Text>
        ) : null}
        {actions.length ? (
          // Above the card's own button, so each is pressed on its own.
          <div className="relative z-10 mt-1 flex flex-wrap items-center gap-x-3">
            {actions.map((action) => (
              <Button key={action.id} variant="text" tone="accent" size="sm" className="!px-0" onPress={action.onPress} data-testid={action.testId}>
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </Surface>
  );
}
