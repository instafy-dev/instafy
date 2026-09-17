import { Check } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import {
  CARD_CHIP_CONNECTORS,
  COMING_SOON_FEATURED_SKILLS,
  formatComingSoonLine,
  type SkillConnector,
} from "./connectors";

// Presentational: the getting-started card's "Connect a tool" strip. One
// hairline pill chip per featured skill that can be selected today (bare mark
// plus name) and a trailing "More tools" text link that opens the browse
// sheet. A press only reports the connector; nothing is sent. While no
// featured skill is available, the chips give way to one muted line naming
// what is coming ("Slack and Discord are coming soon.") ahead of the
// same link; the Soon badges live in the sheet, where the full list is.

type ConnectChipStripProps = {
  installedSkillNames: ReadonlySet<string>;
  onSelect: (connector: SkillConnector) => void;
  onMoreTools: () => void;
  className?: string;
  /** Id of the visible caption that labels the list (e.g. "Connect a tool"). */
  "aria-labelledby"?: string;
  /** Test seam: the chips to render (defaults to the shipped list). */
  connectors?: readonly SkillConnector[];
  /** Test seam: the skills named in the coming-soon line. */
  comingSoon?: readonly SkillConnector[];
};

export function ConnectChipStrip({
  installedSkillNames,
  onSelect,
  onMoreTools,
  className,
  "aria-labelledby": ariaLabelledBy,
  connectors = CARD_CHIP_CONNECTORS,
  comingSoon = COMING_SOON_FEATURED_SKILLS,
}: ConnectChipStripProps) {
  const comingSoonLine = connectors.length === 0 ? formatComingSoonLine(comingSoon) : null;
  return (
    <ul
      className={["flex flex-wrap items-center gap-1.5", className].filter(Boolean).join(" ")}
      aria-labelledby={ariaLabelledBy}
      data-testid="connect-chip-strip"
    >
      {connectors.map((connector) => {
        const Mark = connector.mark;
        const connected = installedSkillNames.has(connector.skillName);
        // The visible chip is mark plus name; the accessible name adds the
        // verb, or the state in place of it.
        const accessibleName = connected
          ? `${connector.name}, connected`
          : `Connect ${connector.name}`;
        return (
          <li key={connector.id}>
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
      {comingSoonLine ? (
        <li>
          <Text as="span" variant="caption" tone="muted" data-testid="connect-coming-soon">
            {comingSoonLine}
          </Text>
        </li>
      ) : null}
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
