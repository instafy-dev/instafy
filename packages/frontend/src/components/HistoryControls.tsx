import { Redo, Undo } from "iconoir-react";
import { IconButton } from "./Button";
import { useCode } from "../code/useCode";

export function HistoryControls() {
  const { undo, redo, historyLength, futureLength } = useCode();

  return (
    <>
      <IconButton
        onPress={undo}
        isDisabled={historyLength === 0}
        variant="ghost"
        tone="muted"
        size="sm"
        aria-label="Undo"
        title="Undo"
      >
        <Undo className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton
        onPress={redo}
        isDisabled={futureLength === 0}
        variant="ghost"
        tone="muted"
        size="sm"
        aria-label="Redo"
        title="Redo"
      >
        <Redo className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </>
  );
}
