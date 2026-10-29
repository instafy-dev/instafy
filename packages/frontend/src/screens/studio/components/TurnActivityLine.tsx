import { useEffect, useRef, useState } from "react";
import { NavArrowDown, NavArrowRight } from "iconoir-react";
import { Text } from "../../../components/Text";
import { useSteadyActivityLabel } from "./useSteadyActivityLabel";

// The chat's focus ring, as on the file chips and the run rail before them.
const LINE_FOCUS_CLASS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-primary-300/80 dark:focus-visible:ring-offset-slate-950";

/** Screen readers hear a new running label at most this often. */
export const LIVE_ANNOUNCEMENT_INTERVAL_MS = 5_000;

/**
 * The running label as a polite live region hears it: only when it changes,
 * and at most once every {@link LIVE_ANNOUNCEMENT_INTERVAL_MS}. The region
 * starts empty, so the label a turn opens with is not read out on load.
 */
function useThrottledAnnouncement(text: string): string {
  const [announced, setAnnounced] = useState("");
  const lastAnnouncedAt = useRef(0);
  const firstText = useRef(text);
  useEffect(() => {
    if (text === announced || text === firstText.current) {
      return;
    }
    firstText.current = "";
    const wait = Math.max(0, lastAnnouncedAt.current + LIVE_ANNOUNCEMENT_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      lastAnnouncedAt.current = Date.now();
      setAnnounced(text);
    }, wait);
    return () => clearTimeout(timer);
  }, [announced, text]);
  return announced;
}

function LiveAnnouncement({ text }: { text: string }) {
  const announced = useThrottledAnnouncement(text);
  return (
    <span className="sr-only" aria-live="polite" data-testid="turn-activity-announcement">
      {announced}
    </span>
  );
}

export type TurnActivityLineProps = {
  /** "Looking up places…" while the turn runs, "Looked up 14 places" once done. */
  text: string;
  /** The turn is running: the line sweeps, holds each label and announces its changes. */
  live: boolean;
  animate: boolean;
  /** The turn has no step yet: the line opens with "Starting…" until the model has worked a moment. */
  noStepsYet?: boolean;
  /** The line opens Details. False on a failed turn, whose failure block has the one Details. */
  interactive: boolean;
  detailsOpen: boolean;
  detailsId: string;
  onToggleDetails: () => void;
};

/**
 * One quiet line that says what the turn did, in plain words. Once a step
 * exists the whole line is one button that opens Details.
 */
export function TurnActivityLine({
  text: latestText,
  live,
  animate,
  noStepsYet = false,
  interactive,
  detailsOpen,
  detailsId,
  onToggleDetails,
}: TurnActivityLineProps) {
  // While the turn runs, a label holds until the next one has lasted: a step
  // that ends at once, or a short pause between steps, never flashes past.
  const text = useSteadyActivityLabel(latestText, live, noStepsYet);
  const sweep = live && animate ? "instafy-status-sweep" : "";
  const label = (
    <span className={`${sweep} min-w-0 truncate`} data-sweep-text={text}>
      {text}
    </span>
  );
  return (
    <div className="relative min-w-0" data-testid="turn-activity">
      {interactive ? (
        <Text
          as="button"
          type="button"
          variant="caption"
          tone="muted"
          data-testid="turn-activity-line"
          // The sweep repeats the label in a pseudo-element, which would be
          // read into the name twice: the name is the line plus its action.
          aria-label={`${text} ${detailsOpen ? "Hide details" : "Details"}`}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          title={text}
          onClick={onToggleDetails}
          className={`group/turn-activity flex h-5 max-w-full min-w-0 items-center gap-1.5 rounded-md text-left leading-5 hover:text-slate-800 dark:hover:text-slate-100 pointer-coarse:min-h-11 ${LINE_FOCUS_CLASS}`}
        >
          {label}
          <span className="inline-flex flex-none items-center gap-0.5 font-medium group-hover/turn-activity:underline">
            {detailsOpen ? "Hide details" : "Details"}
            {detailsOpen ? (
              <NavArrowDown aria-hidden="true" className="h-3 w-3" />
            ) : (
              <NavArrowRight aria-hidden="true" className="h-3 w-3" />
            )}
          </span>
        </Text>
      ) : (
        <Text
          as="div"
          variant="caption"
          tone="muted"
          data-testid="turn-activity-line"
          title={text}
          className="flex h-5 max-w-full min-w-0 items-center leading-5"
        >
          {label}
        </Text>
      )}
      {live ? <LiveAnnouncement text={text} /> : null}
    </div>
  );
}
