import { Check } from "iconoir-react";
import { Button } from "../../../components/Button";
import { CARD_TOOL_CONNECTORS, type ProductConnector } from "./connectors";

// Presentational: the getting-started card's row of tools. One hairline pill
// chip per featured tool that can be picked today (bare mark plus name) and a
// trailing "More tools" text link that opens the browse sheet. A press only
// reports the tool; nothing is sent. The row cannot be empty on the card,
// because GitHub is always in it, so there is no "nothing here yet" state to
// render; a tool whose pack is unpublished is listed in the sheet with a Soon
// Badge instead, where the full catalogue is.
//
// Nothing in the row says how a tool connects. A sign-in tool and a key tool
// produce the same chip, because that difference belongs to setup, which is
// the sheet's confirm stage, not to the offer. That is what lets this row
// absorb dozens of tools without a redesign.

type ConnectChipStripProps = {
  installedSkillNames: ReadonlySet<string>;
  onSelect: (connector: ProductConnector) => void;
  onMoreTools: () => void;
  className?: string;
  /** Id of the visible heading that labels the list. */
  "aria-labelledby"?: string;
  /** Test seam: the chips to render (defaults to the shipped list). */
  connectors?: readonly ProductConnector[];
  /**
   * False drops the trailing link. Read-only members keep the chips whose
   * press sends nothing and lose the browse sheet, whose Connect button does.
   */
  showMoreTools?: boolean;
};

export function ConnectChipStrip({
  installedSkillNames,
  onSelect,
  onMoreTools,
  className,
  "aria-labelledby": ariaLabelledBy,
  connectors = CARD_TOOL_CONNECTORS,
  showMoreTools = true,
}: ConnectChipStripProps) {
  return (
    <ul
      className={["flex flex-wrap items-center gap-1.5", className].filter(Boolean).join(" ")}
      aria-labelledby={ariaLabelledBy}
      data-testid="connect-chip-strip"
    >
      {connectors.map((connector) => {
        const Mark = connector.mark;
        // Only a skill can be connected: importing a repo installs nothing,
        // and a finished device session inside one import attempt is not
        // durable knowledge, so GitHub never carries the glyph.
        const connected =
          connector.kind === "skill" && installedSkillNames.has(connector.skillName);
        // The visible chip is mark plus name; the accessible name adds the
        // verb, or the state in place of it, and always contains the visible
        // name so a voice-control user can say what they read.
        const accessibleName =
          connector.kind === "github"
            ? `Import from ${connector.name}`
            : connected
              ? `${connector.name}, connected`
              : `Connect ${connector.name}`;
        return (
          // flex on the item, not just the list: an inline-flex Button in a
          // block li sits on a line box whose strut adds descender space, so
          // the li grows past the control and items-center then centres the
          // box, not the control. The bordered chip and the borderless link
          // differ in height, so that strut left the link 1.5 px below the
          // chips' optical centre. A flex li is exactly its control's height.
          <li key={connector.id} className="flex">
            <Button
              variant="outline"
              size="xs"
              radius="full"
              className="gap-1.5 px-2.5 shadow-none"
              aria-label={accessibleName}
              onPress={() => onSelect(connector)}
              data-testid={`connect-chip-${connector.id}`}
            >
              <Mark className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-medium">{connector.name}</span>
              {connected ? (
                <Check
                  className="h-3 w-3 text-primary-600 dark:text-primary-300"
                  aria-hidden="true"
                  data-testid={`connect-chip-${connector.id}-connected`}
                />
              ) : null}
            </Button>
          </li>
        );
      })}
      {showMoreTools ? (
        <li className="flex">
          <Button
            variant="ghost"
            size="xs"
            radius="full"
            className="px-2 underline-offset-2 hover:underline"
            onPress={onMoreTools}
            data-testid="connect-more-tools"
          >
            {/* The lighter tone sits on a span: Button joins classes without
                tailwind-merge, so a text colour on the Button itself loses to
                the ghost variant's text-slate-700 in light mode. */}
            <span className="text-slate-500 dark:text-slate-400">More tools</span>
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
