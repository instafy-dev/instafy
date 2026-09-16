import { Check } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CARD_CHIP_CONNECTORS, isConnectorAvailable, type SkillConnector } from "./connectors";

// Presentational: the getting-started card's "Connect a tool" strip. One
// hairline pill chip per featured skill (bare mark plus name) and a trailing
// "More tools" text link that opens the browse sheet. A press only reports
// the connector; nothing is sent. A "soon" skill (pack not published yet)
// renders as a disabled chip with a "Soon" Badge and reports nothing.

// Shown on hover over a disabled chip. It sits on the list item because the
// disabled Button has pointer-events none, so the pointer reaches the item.
const SOON_TITLE = "Coming soon";

type ConnectChipStripProps = {
  installedSkillNames: ReadonlySet<string>;
  onSelect: (connector: SkillConnector) => void;
  onMoreTools: () => void;
  className?: string;
  /** Id of the visible caption that labels the list (e.g. "Connect a tool"). */
  "aria-labelledby"?: string;
};

export function ConnectChipStrip({
  installedSkillNames,
  onSelect,
  onMoreTools,
  className,
  "aria-labelledby": ariaLabelledBy,
}: ConnectChipStripProps) {
  return (
    <ul
      className={["flex flex-wrap items-center gap-1.5", className].filter(Boolean).join(" ")}
      aria-labelledby={ariaLabelledBy}
      data-testid="connect-chip-strip"
    >
      {CARD_CHIP_CONNECTORS.map((connector) => {
        const Mark = connector.mark;
        const soon = !isConnectorAvailable(connector);
        // "Soon" wins over the installed state: the pack is not published, so
        // the chip cannot lead anywhere yet.
        const connected = !soon && installedSkillNames.has(connector.skillName);
        // The visible chip is mark plus name; the accessible name adds the
        // verb, or the state in place of it.
        const accessibleName = soon
          ? `${connector.name}, coming soon`
          : connected
            ? `${connector.name}, connected`
            : `Connect ${connector.name}`;
        return (
          <li key={connector.id} title={soon ? SOON_TITLE : undefined}>
            <Button
              variant="outline"
              size="xs"
              radius="full"
              className="gap-1.5 px-2.5 shadow-none"
              aria-label={accessibleName}
              isDisabled={soon}
              onPress={() => {
                if (!soon) {
                  onSelect(connector);
                }
              }}
              data-testid={`connect-chip-${connector.id}`}
            >
              <Mark className="h-4 w-4" aria-hidden="true" />
              <span className="text-xs font-medium">{connector.name}</span>
              {soon ? (
                <Badge tone="neutral" size="xs" data-testid={`connect-chip-${connector.id}-soon`}>
                  Soon
                </Badge>
              ) : connected ? (
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
      <li>
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
    </ul>
  );
}
