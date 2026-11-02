import { useId, type Ref } from "react";
import { AiFace } from "../../../components/AiFace";
import { AI_TILE_SHAPE_CLASS } from "../../../components/OctoCoin";
import { Text } from "../../../components/Text";
import { HATCHLINGS, type Hatchling } from "../../../utils/aiFace";

/** Each pose's name, for its radio's accessible name and tooltip. */
const HATCHLING_NAMES: Record<Hatchling, string> = {
  1: "Hooray",
  2: "Drift",
  3: "Kick",
  4: "Twirl",
  5: "Wave",
  6: "Catch",
  7: "Rest",
  8: "Swim",
};

/**
 * The face a saved agent wears without a picture: one of Octo's eight
 * hatchlings (docs/Brand.md, "Octo's hatchlings"). Native radios, as the team
 * color picker has them: 44px targets, arrow keys between faces, and a
 * selected border on the AI tile's corners, so the choice never rests on
 * telling two small drawings apart.
 */
export function AgentFacePicker({
  value,
  onChange,
  disabled = false,
  ref,
}: {
  value: Hatchling;
  onChange: (face: Hatchling) => void;
  disabled?: boolean;
  ref?: Ref<HTMLFieldSetElement>;
}) {
  const name = useId();
  return (
    <fieldset ref={ref} disabled={disabled} className="min-w-0" data-testid="agent-face-picker">
      <Text as="legend" variant="fieldLabel" tone="secondary" className="mb-2 block">Face</Text>
      {/* Eight in a row, or two rows of four where a row of eight would
          leave one face on a line of its own. */}
      <div className="grid w-fit grid-cols-4 gap-1 sm:grid-cols-8">
        {HATCHLINGS.map((face) => (
          <label
            key={face}
            title={HATCHLING_NAMES[face]}
            className={[
              `flex h-11 w-11 items-center justify-center border-2 border-transparent ${AI_TILE_SHAPE_CLASS}`,
              "has-checked:border-primary-600 dark:has-checked:border-primary-400 forced-colors:has-checked:border-[Highlight]",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary-500",
              disabled ? "opacity-60" : "cursor-pointer",
            ].join(" ")}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={face}
              aria-label={HATCHLING_NAMES[face]}
              checked={value === face}
              onChange={() => onChange(face)}
              data-testid={`agent-face-option-${face}`}
            />
            <AiFace face={{ kind: "hatchling", n: face, reason: "stamp" }} className="h-8 w-8" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
