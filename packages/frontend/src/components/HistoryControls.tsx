import { Redo, Undo } from "iconoir-react";
import { IconButton } from "./Button";
import { useCode } from "../code/useCode";

export function HistoryControls() {
  const { undo, redo, historyLength, futureLength } = useCode();

  return (
    <div className="flex items-center gap-1">
      <IconButton
        onPress={undo}
        isDisabled={historyLength === 0}
        variant="outline"
        size="sm"
        radius="full"
        aria-label="Undo"
        title="Undo"
        className="text-slate-500 dark:text-slate-300"
      >
        <Undo className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton
        onPress={redo}
        isDisabled={futureLength === 0}
        variant="outline"
        size="sm"
        radius="full"
        aria-label="Redo"
        title="Redo"
        className="text-slate-500 dark:text-slate-300"
      >
        <Redo className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </div>
  );
}
