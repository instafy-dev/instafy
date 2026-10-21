import { Collapse, Expand } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";

/** Shared expansion action for toolbar and compact browser options. */
export function BrowserExpandButton({
  expanded,
  onPress,
  showLabel = false,
  testId = "browser-session-fullscreen-toggle",
}: {
  expanded: boolean;
  onPress: () => void;
  testId?: string;
  showLabel?: boolean;
}) {
  const label = expanded ? "Exit expanded browser" : "Expand browser";
  const Component = showLabel ? Button : IconButton;
  return (
    <Component
      aria-expanded={expanded}
      aria-label={label}
      className={showLabel ? "w-full justify-start" : "shrink-0"}
      data-testid={testId}
      onPress={onPress}
      size="sm"
      title={label}
      variant="ghost"
    >
      {expanded ? <Collapse className="h-4 w-4" aria-hidden="true" /> : <Expand className="h-4 w-4" aria-hidden="true" />}
      {showLabel ? label : null}
    </Component>
  );
}
