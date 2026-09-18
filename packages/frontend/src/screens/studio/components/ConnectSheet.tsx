import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavArrowLeft } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import {
  AVAILABLE_FEATURED_CONNECTORS,
  CONNECTOR_CATEGORIES,
  FEATURED_CONNECTOR_LIMIT,
  filterConnectors,
  isConnectorAvailable,
  type ProductConnector,
  type SkillConnector,
} from "./connectors";
import type { ConnectSheetStage } from "./useConnectSheetState";

// The one Connect dialog. Stage "browse" (from "More tools" on the card or
// "Browse all tools" in the composer menu) is a search box, a curated
// "Popular" row of bare marks and the full list in category sections; a row
// only reports the connector. A "soon" connector (pack not published yet)
// stays listed, greyed and disabled with a "Soon" Badge, and is left out of
// Popular. Stage "confirm" is the per-skill confirm whose
// "Connect" button is the only sending control in the whole flow. Cancel,
// Close, Escape, Back, "Paste a skill link", "Search all skills" and
// "Set up again" never send.

type ConnectSheetProps = {
  isOpen: boolean;
  stage: ConnectSheetStage;
  /** The skill being confirmed; null in the browse stage. */
  target: SkillConnector | null;
  /** True when the confirm stage was reached from the browse stage. */
  showBack: boolean;
  installedSkillNames: ReadonlySet<string>;
  pending: boolean;
  /** A browse row or Popular mark press; the host routes it (skill or GitHub). */
  onSelect: (connector: ProductConnector) => void;
  onBack: () => void;
  /** "Paste a skill link" in the browse footer: the host closes and opens the import modal. */
  onPasteLink: () => void;
  /** "Search all skills" in the empty state: the host closes and opens Skills discovery with the query. */
  onSearchAllSkills: (query: string) => void;
  onConnect: (connector: SkillConnector) => void;
  onSetUpAgain: (connector: SkillConnector) => void;
  onClose: () => void;
};

const CODE_CLASS = "break-all rounded bg-slate-100 px-1 py-0.5 text-xxs dark:bg-slate-800";
const MARK_CLASS = "h-4 w-4 flex-none";
// The same hairline as StudioDialogHeader, so both stages match the header in
// the dark theme (a raw slate step would not).
const FOOTER_CLASS =
  "flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 pt-3 dark:border-[color:var(--color-studio-dark-divider)]";
// Stage roots take focus after an in-dialog transition. The pressed row or
// mark unmounts with its stage, and react-aria's FocusScope would otherwise
// drop focus on the first tabbable control, the header Close, so a second
// Enter would dismiss the sheet.
const STAGE_ROOT_CLASS = "space-y-3 p-4 outline-none";
// Popular is worth a row only once it can offer a choice. Exported so a test
// can assert the catalogue still clears it: AVAILABLE_FEATURED_CONNECTORS
// sits close to this number, and un-featuring one entry would delete the row
// silently.
export const POPULAR_MIN_AVAILABLE = 2;
// Shown on hover over a disabled row. It sits on the list item because the
// disabled Button has pointer-events none, so the pointer reaches the item.
const SOON_TITLE = "Coming soon";

// The confirm stage answers three questions and no others: what connecting
// this lets Instafy do, what the person will have to go and fetch, and whether
// anything in their account changes without them. It used to spend three of
// its four lines on the repo it installs from, the environment variable the
// setup will ask for and the folder the files land in, which is the shape of
// the thing rather than the point of it.

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five"];

function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) {
    return phrases[0] ?? "";
  }
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * What the person fetches, in the provider's own words when the connector
 * declares them. Falls back to the `needs` phrases as written for a connector
 * that has not declared its credentials yet.
 */
function neededValuePhrases(connector: SkillConnector): string[] {
  if (connector.credentials && connector.credentials.length > 0) {
    return connector.credentials.map((credential) => `the ${credential.valueLabel}`);
  }
  return [...connector.needs];
}

function installLine(connector: SkillConnector): ReactNode {
  if (connector.app) {
    return (
      <>
        {connector.purpose} Setup opens {connector.name} in the shared display; you sign in
        there once, and Instafy then works in that session.
      </>
    );
  }
  return <>{connector.purpose} Setup runs here, in this chat.</>;
}

function needsLine(connector: SkillConnector): ReactNode {
  const phrases = neededValuePhrases(connector);
  const plural = phrases.length > 1;
  return (
    <>
      You will need {countWord(phrases.length)} {plural ? "things" : "thing"} from{" "}
      {connector.name}: {joinPhrases(phrases)}. Instafy shows a card to paste{" "}
      {plural ? "them" : "it"} into, so {plural ? "they never go" : "it never goes"} into a
      chat message.{connector.sharingNote ? ` ${connector.sharingNote}` : ""}
    </>
  );
}

function isConnected(connector: ProductConnector, installedSkillNames: ReadonlySet<string>): boolean {
  return connector.kind === "skill" && installedSkillNames.has(connector.skillName);
}

// Phones must not pop the keyboard when the sheet opens; only a fine pointer
// (mouse or trackpad) gets the search box focused.
function prefersSearchAutoFocus(): boolean {
  try {
    return window.matchMedia?.("(pointer: fine)")?.matches ?? false;
  } catch {
    return false;
  }
}

function searchStatus(trimmedQuery: string, count: number): string {
  if (trimmedQuery.length === 0) {
    return "";
  }
  if (count === 0) {
    return `No tool named "${trimmedQuery}".`;
  }
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function BrowseStage({
  query,
  onQueryChange,
  focusOnMount,
  installedSkillNames,
  onSelect,
  onPasteLink,
  onSearchAllSkills,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  /** True when Back brought the list back; the root takes focus unless the search box does. */
  focusOnMount: boolean;
  installedSkillNames: ReadonlySet<string>;
  onSelect: (connector: ProductConnector) => void;
  onPasteLink: () => void;
  onSearchAllSkills: (query: string) => void;
  onClose: () => void;
}) {
  const [autoFocusSearch] = useState(prefersSearchAutoFocus);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocusSearch && focusOnMount) {
      rootRef.current?.focus();
    }
  }, [autoFocusSearch, focusOnMount]);
  const trimmedQuery = query.trim();
  const matches = useMemo(() => filterConnectors(query), [query]);
  const sections = useMemo(
    () =>
      CONNECTOR_CATEGORIES.map((category) => ({
        category,
        connectors: matches.filter((connector) => connector.category === category.id),
      })).filter((section) => section.connectors.length > 0),
    [matches],
  );
  const popular = AVAILABLE_FEATURED_CONNECTORS.slice(0, FEATURED_CONNECTOR_LIMIT);
  const showPopular = trimmedQuery.length === 0 && popular.length >= POPULAR_MIN_AVAILABLE;

  return (
    <div ref={rootRef} tabIndex={-1} className={STAGE_ROOT_CLASS} data-testid="connect-browse-stage">
      <Input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search tools"
        aria-label="Search tools"
        autoComplete="off"
        autoFocus={autoFocusSearch}
        size="sm"
        radius="xl"
        data-testid="connect-search"
      />
      {/* The list re-renders silently as the query narrows it; this voices the count. */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="connect-search-status">
        {searchStatus(trimmedQuery, matches.length)}
      </p>
      {showPopular ? (
        <div data-testid="connect-popular">
          {/* "Popular" is the curated featured flag on connectors.ts, not a measurement. */}
          <Text as="p" id="connect-popular-label" variant="caption" tone="muted">
            Popular
          </Text>
          <ul
            className="mt-1.5 flex flex-wrap items-center gap-2"
            aria-labelledby="connect-popular-label"
            data-testid="connect-popular-row"
          >
            {popular.map((connector) => {
              const Mark = connector.mark;
              return (
                <li key={connector.id}>
                  <IconButton
                    variant="outline"
                    size="md"
                    radius="full"
                    className="shadow-none"
                    aria-label={connector.name}
                    title={connector.name}
                    onPress={() => onSelect(connector)}
                    data-testid={`connect-popular-${connector.id}`}
                  >
                    <Mark className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {sections.length > 0 ? (
        <div className="space-y-3" data-testid="connect-categories">
          {sections.map(({ category, connectors }) => (
            <div
              key={category.id}
              role="group"
              aria-labelledby={`connect-category-${category.id}`}
              data-testid={`connect-category-${category.id}`}
            >
              <Text as="p" id={`connect-category-${category.id}`} variant="caption" tone="muted">
                {category.label}
              </Text>
              <ul className="mt-1 -mx-1 space-y-0.5">
                {connectors.map((connector) => {
                  const Mark = connector.mark;
                  const soon = !isConnectorAvailable(connector);
                  // "Soon" wins over the installed state and the region: the
                  // pack is not published, so the row cannot lead anywhere yet.
                  // The name keeps the primary tone; the disabled Button's
                  // opacity greys the whole row, as on the chip and menu row,
                  // and a muted tone on top would blend the name too far.
                  const connected = !soon && isConnected(connector, installedSkillNames);
                  const meta = soon ? null : connected ? "connected" : connector.region ?? null;
                  const metaTestId = `connect-row-${connector.id}-meta`;
                  return (
                    <li key={connector.id} title={soon ? SOON_TITLE : undefined}>
                      <Button
                        variant="ghost"
                        size="sm"
                        radius="xl"
                        className="w-full justify-start px-2.5 text-left"
                        isDisabled={soon}
                        onPress={() => {
                          if (!soon) {
                            onSelect(connector);
                          }
                        }}
                        data-testid={`connect-row-${connector.id}`}
                      >
                        <span className="flex w-full min-w-0 items-center gap-2.5">
                          <Mark className={MARK_CLASS} aria-hidden="true" />
                          <Text
                            as="span"
                            variant="body"
                            tone="primary"
                            className="min-w-0 flex-1 truncate"
                          >
                            {connector.name}
                          </Text>
                          {soon ? (
                            <Badge tone="neutral" size="xs" className="flex-none" data-testid={metaTestId}>
                              Soon
                            </Badge>
                          ) : meta ? (
                            <Text
                              as="span"
                              variant="caption"
                              tone="muted"
                              className="flex-none"
                              data-testid={metaTestId}
                            >
                              {meta}
                            </Text>
                          ) : null}
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2 py-1" data-testid="connect-empty">
          <Text as="p" variant="body" tone="secondary">
            No tool named &quot;{trimmedQuery}&quot;.
          </Text>
          <Button
            variant="ghost"
            size="sm"
            radius="xl"
            className="-mx-2.5"
            onPress={() => onSearchAllSkills(trimmedQuery)}
            data-testid="connect-search-all"
          >
            Search all skills
          </Button>
        </div>
      )}
      <div className={FOOTER_CLASS}>
        <Button
          variant="ghost"
          size="sm"
          radius="xl"
          className="-ml-2.5 underline-offset-2 hover:underline"
          onPress={onPasteLink}
          data-testid="connect-paste-link"
        >
          {/* Tone on a span: a text colour on the Button loses to the ghost
              variant's text-slate-700 (no tailwind-merge). */}
          <span className="text-slate-500 dark:text-slate-400">Paste a skill link</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          radius="xl"
          onPress={onClose}
          data-testid="connect-browse-cancel"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ConfirmStage({
  connector,
  connected,
  showBack,
  pending,
  onBack,
  onConnect,
  onSetUpAgain,
  onClose,
}: {
  connector: SkillConnector;
  connected: boolean;
  showBack: boolean;
  pending: boolean;
  onBack: () => void;
  onConnect: (connector: SkillConnector) => void;
  onSetUpAgain: (connector: SkillConnector) => void;
  onClose: () => void;
}) {
  const skillPath = `.agents/skills/${connector.skillName}`;
  const rootRef = useRef<HTMLDivElement>(null);
  // A confirm opened from a chip or menu row keeps the dialog's own mount
  // focus; one reached from the list takes it here.
  useEffect(() => {
    if (showBack) {
      rootRef.current?.focus();
    }
  }, [showBack]);
  return (
    <div ref={rootRef} tabIndex={-1} className={STAGE_ROOT_CLASS} data-testid="connect-confirm-stage">
      {connected ? (
        <Text as="p" variant="body" tone="secondary" data-testid="connect-confirm-install-line">
          The {connector.name} skill is in this space at <code className={CODE_CLASS}>{skillPath}</code>.
        </Text>
      ) : (
        <>
          <Text as="p" variant="body" tone="secondary" data-testid="connect-confirm-install-line">
            {installLine(connector)}
          </Text>
          {connector.needs.length > 0 ? (
            <Text as="p" variant="caption" tone="muted" data-testid="connect-confirm-needs-line">
              {needsLine(connector)}
            </Text>
          ) : null}
          <Text as="p" variant="caption" tone="muted" data-testid="connect-confirm-safety-line">
            Instafy never changes anything in {connector.name} without asking you first,
            every time.
          </Text>
        </>
      )}
      <div className={FOOTER_CLASS}>
        <div>
          {showBack ? (
            <Button
              variant="ghost"
              size="sm"
              radius="xl"
              className="-ml-2.5 gap-1"
              onPress={onBack}
              data-testid="connect-confirm-back"
            >
              <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            radius="xl"
            onPress={onClose}
            data-testid="connect-confirm-cancel"
          >
            Cancel
          </Button>
          {connected ? (
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              onPress={() => onSetUpAgain(connector)}
              data-testid="connect-confirm-set-up-again"
            >
              Set up again
            </Button>
          ) : (
            // The only sending control. Closing the sheet mid-send is
            // harmless (the flow's toast still reports), so Cancel, Close
            // and Escape stay live while this one waits. isPending (not
            // isDisabled) keeps the button focusable so a keyboard user's
            // focus, the dialog's Escape handler and the Tab cycle survive
            // the send; presses are ignored and aria-disabled is set.
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              onPress={() => onConnect(connector)}
              isPending={pending}
              data-testid="connect-confirm-submit"
            >
              {pending ? <Spinner tone="primary" size="sm" aria-hidden="true" /> : null}
              Connect
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ConnectSheet({
  isOpen,
  stage,
  target,
  showBack,
  installedSkillNames,
  pending,
  onSelect,
  onBack,
  onPasteLink,
  onSearchAllSkills,
  onConnect,
  onSetUpAgain,
  onClose,
}: ConnectSheetProps) {
  // The query lives on the sheet, not the stage, so Back returns to the list
  // as it was; it resets when the sheet closes.
  const [query, setQuery] = useState("");
  // True once Back has shown the list again during this opening: the browse
  // root then takes focus on mount (see STAGE_ROOT_CLASS).
  const [returnedFromConfirm, setReturnedFromConfirm] = useState(false);
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setReturnedFromConfirm(false);
    }
  }, [isOpen]);
  const handleBack = () => {
    setReturnedFromConfirm(true);
    onBack();
  };

  const confirming = stage === "confirm" && target !== null;
  const connected = target ? installedSkillNames.has(target.skillName) : false;
  const Mark = confirming && target ? target.mark : null;
  const title = confirming && target
    ? connected
      ? `${target.name} is connected`
      : `Connect ${target.name}`
    : "Connect a tool";

  return (
    <StudioDialogModal
      isOpen={isOpen}
      isDismissable
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      className="h-[100dvh] min-h-0 overflow-hidden"
      modalClassName="min-h-0 max-h-full w-full max-w-md overflow-y-auto overscroll-contain"
      dialogAriaLabel={title}
      data-testid="connect-sheet"
    >
      <StudioDialogHeader
        title={title}
        leading={
          Mark ? (
            <Mark
              className="mt-0.5 h-5 w-5 flex-none text-slate-500 dark:text-slate-400"
              aria-hidden="true"
            />
          ) : undefined
        }
        onClose={onClose}
        closeLabel="Close"
      />
      {confirming && target ? (
        <ConfirmStage
          connector={target}
          connected={connected}
          showBack={showBack}
          pending={pending}
          onBack={handleBack}
          onConnect={onConnect}
          onSetUpAgain={onSetUpAgain}
          onClose={onClose}
        />
      ) : (
        <BrowseStage
          query={query}
          onQueryChange={setQuery}
          focusOnMount={returnedFromConfirm}
          installedSkillNames={installedSkillNames}
          onSelect={onSelect}
          onPasteLink={onPasteLink}
          onSearchAllSkills={onSearchAllSkills}
          onClose={onClose}
        />
      )}
    </StudioDialogModal>
  );
}
