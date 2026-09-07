import { Collapse, Expand } from "iconoir-react";
import { IconButton } from "../../../components/Button";

/** Keep expansion available even when browser chrome uses compact labels. */
export function BrowserExpandButton({
  expanded,
  onPress,
  testId = "browser-session-fullscreen-toggle",
}: {
  expanded: boolean;
  onPress: () => void;
  testId?: string;
}) {
  const label = expanded ? "Exit expanded browser" : "Expand browser";
  return (
    <IconButton
      aria-expanded={expanded}
      aria-label={label}
      className="shrink-0 text-slate-500 max-[540px]:h-10 max-[540px]:w-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11 dark:text-slate-400"
      data-testid={testId}
      onPress={onPress}
      radius="full"
      size="sm"
      title={label}
      variant="ghost"
    >
      {expanded ? <Collapse className="h-4 w-4" aria-hidden="true" /> : <Expand className="h-4 w-4" aria-hidden="true" />}
    </IconButton>
  );
}
