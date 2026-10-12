import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Bell,
  ChatLines,
  ClipboardCheck,
  Coins,
  Eye,
  GitBranch,
  Menu,
  Microphone,
  MoreHoriz,
  NavArrowRight,
  OpenNewWindow,
  Page,
  Plus,
  Send,
  SidebarCollapse,
  SidebarExpand,
  Terminal,
  Threads,
  Undo,
  Xmark,
} from "iconoir-react";
import { ChatsIcon, HomeIcon } from "../../components/AppIcons";
import { ControlChevron } from "../../components/ControlChevron";
import { OctoCoin } from "../../components/OctoCoin";
import type { OctoMarkMotion } from "../../components/OctoMark";
import { Spinner } from "../../components/Spinner";
import { Surface } from "../../components/Surface";
import { Text } from "../../components/Text";
import { getUnifiedDiffRowClass } from "../../utils/unifiedDiff";
import { ChatActivityBubble } from "../studio/components/ChatActivityBubble";
import { ChatBubbleRow } from "../studio/components/ChatBubbleRow";
import { CHAT_COLUMN_CLASS_NAME, ChatColumn } from "../studio/components/ChatColumn";
import { SidebarOrgDeck } from "../studio/components/SidebarOrgDeck";
import { ThreadSpine } from "../studio/components/ThreadSpine";
import { LANDING_CREW, type CrewColor } from "./landingCrew";
import * as chrome from "./landingStudioChrome";
import {
  BEAT,
  TYPEWRITER_TICK_MS,
  TYPEWRITER_TICKS,
  beatIndex,
  beatReached,
  browserContinuation,
  type MessagePart,
  type SessionScenario,
  type TurnBeatId,
  type TurnFile,
  type TurnStep,
  type TurnStepKind,
} from "./landingTurnScript";

// Crew colours, one per participant in roster order, as inline styles
// (Tailwind never sees them). Octo has no crew colour: it stays ink.
const ADA = LANDING_CREW.ada;
const KIM = LANDING_CREW.kim;
const AGENT = LANDING_CREW.agent;

const FORMA_TEAM = { key: "forma", name: "Forma", avatarUrl: null };

// ---------------------------------------------------------------------------
// Shared pieces

// Persistent beat elements are laid out at final size from the first paint and
// only fade and lift into place, so no beat ever shifts the layout.
function Reveal({
  visible,
  className,
  testId,
  children,
}: {
  visible: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-beat-visible={visible ? "true" : "false"}
      className={[chrome.REVEAL_BASE, visible ? chrome.REVEAL_SHOWN : chrome.REVEAL_HIDDEN, className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

type AvatarSize = "2xs" | "sm" | "roster";
const AVATAR_SIZE: Record<AvatarSize, string> = { "2xs": chrome.AVATAR_2XS, sm: chrome.AVATAR_SM, roster: chrome.AVATAR_ROSTER };

// ChatMessageAvatar.tsx:102-166 for a human: the crew colour stands in for the
// app's muted ID-hashed palette so Ada and Kim keep one colour across the whole
// page, with the label colour that reads on that fill. An agent other than
// Octo is the same coin as a rounded square (docs/Brand.md): its crew fill and
// its initial, never Octo's mark in a crew colour.
function CrewAvatar({
  initial,
  crew,
  size,
  agent = false,
}: {
  initial: string;
  crew: CrewColor;
  size: AvatarSize;
  agent?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-crew-fill={crew.fill}
      className={`${agent ? chrome.AVATAR_SHELL_AGENT : chrome.AVATAR_SHELL} ${AVATAR_SIZE[size]} ${chrome.AVATAR_HUMAN}`}
      style={{ backgroundColor: crew.fill, color: crew.on }}
    >
      {initial}
    </span>
  );
}

// ChatMessageAvatar.tsx's Octo face: the studio's own coin component
// (OctoCoin), not a copy of its classes, so the landing's Octo is the app's.
// Octo is ink, never a crew colour, and its coin mark stays one ink.
function OctoAvatar({
  size,
  motion = "idle",
  title = "Octo",
  testId,
  pop = false,
}: {
  size: AvatarSize;
  motion?: OctoMarkMotion;
  title?: string;
  testId?: string;
  /** Pops once as Octo's result lands (tailwind.css, data-landing-octo-pop). */
  pop?: boolean;
}) {
  return (
    <OctoCoin
      testId={testId}
      data-landing-octo-pop={pop ? "" : undefined}
      className={AVATAR_SIZE[size]}
      motion={motion}
      title={title}
    />
  );
}

// AssistantSpeakerIdentityPill.tsx:100-138 / chatHumanIdentity.tsx:52-75 minus
// the label's own 28px avatar: the gutter avatar is kept at every width here.
function SpeakerLabel({ name, time }: { name: string; time: string }) {
  return (
    <span className={chrome.SPEAKER_LABEL}>
      <span className={chrome.SPEAKER_NAME}>{name}</span>
      <span className={chrome.SPEAKER_TIME}>{time}</span>
    </span>
  );
}

function StepGlyph({ kind, ownerHandle }: { kind: TurnStepKind; ownerHandle?: string }) {
  if (ownerHandle) {
    return <span className={chrome.RAIL_CHIP_INITIAL}>{ownerHandle.charAt(0).toUpperCase()}</span>;
  }
  const className = "h-3.5 w-3.5";
  switch (kind) {
    case "tool":
      return <Threads aria-hidden="true" className={className} />;
    case "command":
      return <Terminal aria-hidden="true" className={className} />;
    case "plan":
      return <ClipboardCheck aria-hidden="true" className={className} />;
    default:
      return <ChatLines aria-hidden="true" className={className} />;
  }
}

// ---------------------------------------------------------------------------
// Rail

function RecentChats({ scenarios, active, runLive }: { scenarios: SessionScenario[]; active: number; runLive: boolean }) {
  return (
    <div className={chrome.RECENT_LIST_WRAP}>
      <ul className={chrome.RECENT_LIST}>
        {scenarios.map((entry, index) => {
          const selected = index === active;
          return (
            <li key={entry.id}>
              <span
                data-testid="landing-rail-chat"
                data-selected={selected ? "true" : "false"}
                className={`${chrome.RECENT_CHAT_ROW} ${selected ? chrome.RECENT_CHAT_ROW_SELECTED : chrome.RECENT_CHAT_ROW_IDLE}`}
              >
                <span className={`${chrome.RECENT_CHAT_TITLE} ${selected ? chrome.RECENT_CHAT_TITLE_SELECTED : chrome.RECENT_CHAT_TITLE_IDLE}`}>
                  {entry.title}
                </span>
                {selected && runLive ? <span className={chrome.RECENT_CHAT_STATUS}>Running</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      <span className={chrome.BROWSE_ALL_ROW}>
        <span className={chrome.BROWSE_ALL_LABEL}>
          <span className="truncate">Browse all chats</span>
          <ControlChevron direction="right" />
        </span>
      </span>
    </div>
  );
}

function ExpandedRow({ shell, label }: { shell: ReactNode; label: ReactNode }) {
  return (
    <li>
      <span className={`${chrome.ROW_EXPANDED} ${chrome.ROW_EXPANDED_INACTIVE}`}>
        <span className={`${chrome.SHELL_EXPANDED} ${chrome.SHELL_INACTIVE}`}>{shell}</span>
        <span className={chrome.RAIL_LABEL}>
          <span>{label}</span>
        </span>
      </span>
    </li>
  );
}

// StudioSidebar.tsx at lg+ (w-56, labels shown): what the studio renders at
// this height, so the remaining nav items spill into More exactly as it does.
export function RailExpanded({
  scenarios,
  active,
  runLive,
  split = false,
}: {
  scenarios: SessionScenario[];
  active: number;
  runLive: boolean;
  /** The window shows a side-by-side split, which needs the collapsed rail. */
  split?: boolean;
}) {
  return (
    <nav aria-hidden="true" data-testid="landing-rail" className={`${split ? "hidden" : "hidden lg:flex"} w-56 ${chrome.RAIL_SURFACE}`}>
      <ul className={chrome.RAIL_LIST}>
        <ExpandedRow shell={<SidebarCollapse className="text-base" aria-hidden="true" />} label="Collapse" />
        <ExpandedRow shell={<HomeIcon className="h-6 w-6" />} label="Home" />
        <li>
          <span className={`${chrome.ROW_EXPANDED} ${chrome.ROW_EXPANDED_INACTIVE}`}>
            <span className={chrome.DECK_SHELL_EXPANDED}>
              <SidebarOrgDeck team={FORMA_TEAM} teamCount={2} otherAttentionCount={0} />
            </span>
            <span className={chrome.RAIL_TEAM_LABEL}>
              <span className="min-w-0 flex-1">
                <Text as="span" variant="bodyStrong" tone="primary" className="block truncate text-sm">
                  {scenarios[active].space}
                </Text>
                <Text as="span" variant="caption" tone="muted" className="block truncate">
                  Forma
                </Text>
              </span>
              <ControlChevron direction="right" />
            </span>
          </span>
        </li>
        <li>
          {/* The nested list carries the selection (StudioSidebar.tsx:1439-1454). */}
          <span className={`${chrome.ROW_EXPANDED} ${chrome.ROW_EXPANDED_INACTIVE}`}>
            <span className={`${chrome.SHELL_EXPANDED} ${chrome.SHELL_EXPANDED_ACTIVE}`}>
              <ChatsIcon className="text-base" aria-hidden="true" />
            </span>
            <span className={chrome.RAIL_CHATS_LABEL}>
              <span>Chats</span>
              <ControlChevron direction="down" />
            </span>
          </span>
          <RecentChats scenarios={scenarios} active={active} runLive={runLive} />
        </li>
        <ExpandedRow shell={<Page className="text-base" aria-hidden="true" />} label="Files" />
        <ExpandedRow shell={<GitBranch className="text-base" aria-hidden="true" />} label="Changes" />
        <ExpandedRow shell={<Coins className="text-base" aria-hidden="true" />} label="Credits" />
        <ExpandedRow shell={<Plus className="text-base" aria-hidden="true" />} label="More" />
      </ul>
      <div className={chrome.RAIL_FOOTER}>
        <span className={chrome.PROFILE_ROW}>
          <span className={chrome.PROFILE_AVATAR} style={{ backgroundColor: ADA.fill, color: ADA.on }}>
            A
          </span>
          <span className="min-w-0 flex-1">
            <Text as="span" variant="bodyStrong" tone="primary" className="block truncate">
              Ada
            </Text>
            <Text as="span" variant="caption" tone="muted" className="block truncate">
              ada@forma.site
            </Text>
          </span>
        </span>
      </div>
    </nav>
  );
}

function CollapsedRow({ active = false, className, children }: { active?: boolean; className?: string; children: ReactNode }) {
  return (
    <li className={`flex justify-center${className ? ` ${className}` : ""}`}>
      <span className={chrome.ROW_COLLAPSED}>
        <span className={`${chrome.SHELL_COLLAPSED} ${active ? chrome.SHELL_COLLAPSED_ACTIVE : chrome.SHELL_INACTIVE}`}>{children}</span>
      </span>
    </li>
  );
}

// StudioSidebar.tsx collapsed: the 64px icon rail at compact density (the
// frame is under 760px tall), with the blue Chats tile active. The studio
// shows it between md and lg, and wherever its sidebar is collapsed: the
// window collapses it to give a side-by-side split its 1024px. A window that
// fits a short first view is too short for every row: the studio then moves
// its secondary tools into More (StudioSidebar.tsx secondaryRowCapacity), so
// Credits, then Changes, leave the rail as the rail's own height requires
// (a size container query on the rail's content box: row i's icon needs
// 44i + 84px of it, the footer included).
export function RailCollapsed({ split = false }: { split?: boolean }) {
  return (
    <nav
      aria-hidden="true"
      data-testid="landing-rail-collapsed"
      className={`${split ? "hidden md:flex" : "hidden md:flex lg:hidden"} w-[4rem] [container-type:size] ${chrome.RAIL_SURFACE}`}
    >
      <ul className={chrome.RAIL_LIST}>
        <CollapsedRow>
          <SidebarExpand className="text-base" aria-hidden="true" />
        </CollapsedRow>
        <CollapsedRow>
          <HomeIcon className="h-6 w-6" />
        </CollapsedRow>
        <li className="flex justify-center">
          <span className={chrome.ROW_COLLAPSED}>
            <span className={chrome.DECK_SHELL_COLLAPSED}>
              <SidebarOrgDeck team={FORMA_TEAM} teamCount={2} otherAttentionCount={0} />
            </span>
          </span>
        </li>
        <CollapsedRow active>
          <ChatsIcon className="text-base" aria-hidden="true" />
        </CollapsedRow>
        <CollapsedRow>
          <Page className="text-base" aria-hidden="true" />
        </CollapsedRow>
        <CollapsedRow className="[@container(max-height:347px)]:hidden">
          <GitBranch className="text-base" aria-hidden="true" />
        </CollapsedRow>
        <CollapsedRow className="[@container(max-height:391px)]:hidden">
          <Coins className="text-base" aria-hidden="true" />
        </CollapsedRow>
        <CollapsedRow>
          <Plus className="text-base" aria-hidden="true" />
        </CollapsedRow>
      </ul>
      <div className={chrome.RAIL_FOOTER_COLLAPSED}>
        <span className={chrome.PROFILE_INITIAL_COLLAPSED}>A</span>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Tab strip and phone bar

// WorkspaceTabs.tsx at md+: one named conversation tab (one tab per open chat
// is the real state), the new-chat "+", then the bell and tab menu.
export function MiniTabStrip({ title }: { title: ReactNode }) {
  return (
    <div aria-hidden="true" data-testid="landing-tab-strip" data-cub-anchor="topbar" className={chrome.TAB_STRIP}>
      <span className={chrome.TAB_BASELINE} />
      <div className="relative flex min-w-0 flex-1 items-end">
        <span className={chrome.TAB_ACTIVE} data-cub-anchor="title">
          <span className={chrome.TAB_CONTENT}>
            <ChatLines className="h-5 w-5" aria-hidden="true" />
            {title}
          </span>
          <span className={chrome.TAB_CLOSE}>
            <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </span>
        <span className={chrome.TAB_ACTION} data-cub-anchor="action">
          <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
      </div>
      <div className={chrome.TAB_ACTIONS}>
        <span className={chrome.TAB_BELL} data-cub-anchor="action">
          <Bell className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className={chrome.TAB_ACTION} data-cub-anchor="action">
          <MoreHoriz className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
      {/* The roster lies over the strip's right end (RosterStack). */}
      <span className={chrome.TAB_ROSTER_SPACE} />
    </div>
  );
}

// StudioTopBar.tsx:521-560 below md: the pill tab. The sidebar toggle, the
// bell and "+" make way for the roster, which lies over the bar's right end
// (RosterStack), as in the approved hero's phone layout (the title, then the
// roster): on a 360 px phone the chat's title then reads whole.
export function MiniPhoneBar({ title }: { title: ReactNode }) {
  return (
    <div aria-hidden="true" data-testid="landing-phone-bar" data-cub-anchor="topbar" data-cub-layout="phone" className={chrome.PHONE_BAR}>
      <div className="flex min-w-0 justify-start">
        <span className={chrome.PHONE_PILL} data-cub-anchor="title">
          <ChatLines className="h-4 w-4 shrink-0" aria-hidden="true" />
          {title}
        </span>
      </div>
      <span className={chrome.PHONE_ROSTER_SPACE} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster

// ChatPanel.tsx:5561-5575 + ConversationRoster.tsx:92-103: humans first, then
// agents, laid over the right end of the window's top bar (chrome.TOP_BAR):
// the row Cub's ledge belongs to, so Octo's coin sits just under the ledge,
// left of him. The scenario agent's slot is laid out from the first frame and
// slides in at step4. Each coin names its participant in data-roster-coin so
// the hero can find Octo's coin and the others without reaching into classes.
export function RosterStack({ scenario, agentVisible }: { scenario: SessionScenario; agentVisible: boolean }) {
  return (
    <div aria-hidden="true" data-testid="landing-roster" className={chrome.ROSTER}>
      <span data-roster-coin="ada" data-cub-anchor="coin" className={chrome.ROSTER_RING}>
        <CrewAvatar initial="A" crew={ADA} size="roster" />
      </span>
      <span data-roster-coin="kim" data-cub-anchor="coin" className={chrome.ROSTER_RING}>
        <CrewAvatar initial="K" crew={KIM} size="roster" />
      </span>
      <span data-roster-coin="octo" data-testid="landing-roster-octo" data-cub-anchor="coin" className={chrome.ROSTER_RING}>
        <OctoAvatar size="roster" />
      </span>
      <span
        data-roster-coin="agent"
        data-testid="landing-roster-agent"
        data-cub-anchor="coin"
        data-beat-visible={agentVisible ? "true" : "false"}
        data-agent-name={scenario.presenceAgent}
        className={`${chrome.ROSTER_RING_AGENT} ${chrome.REVEAL_BASE} ${agentVisible ? chrome.REVEAL_SLIDE_SHOWN : chrome.REVEAL_SLIDE_HIDDEN}`}
      >
        <CrewAvatar initial={scenario.presenceAgent.charAt(0)} crew={AGENT} size="roster" agent />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript pieces

function LineDelta({ added, removed, loading, testId }: { added: number; removed: number; loading: boolean; testId?: string }) {
  return (
    <span className="grid items-center">
      {loading ? <span className={chrome.LOADING_PILL} aria-hidden="true" /> : null}
      <span data-testid={testId} className={`${chrome.LINE_DELTA}${loading ? " invisible" : ""}`}>
        <span className={chrome.LINE_DELTA_ADDED}>+{added}</span>
        {removed > 0 ? <span className={chrome.LINE_DELTA_REMOVED}>-{removed}</span> : null}
      </span>
    </span>
  );
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

// ChatFileChangeList.tsx:762-883 in its rest state: the summary toggle only
// above one file, mono chips with their counts, the divider, Review changes
// and Undo. The count slot is reserved at the counts' width, so pills becoming
// numbers never re-wrap the rail.
function FileRail({
  files,
  railLabel,
  loading,
  artifactOpen,
  withTestIds,
}: {
  files: TurnFile[];
  railLabel: string | null;
  loading: boolean;
  artifactOpen: boolean;
  withTestIds: boolean;
}) {
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className={chrome.FILE_RAIL} data-testid={withTestIds ? "landing-file-rail" : undefined}>
      <div className={chrome.FILE_RAIL_ROW}>
        {files.length > 1 && railLabel ? (
          <span className={chrome.SUMMARY_TOGGLE}>
            <span className="truncate">{railLabel}</span>
            <LineDelta added={totalAdded} removed={totalRemoved} loading={loading} />
            <NavArrowRight className="-ml-0.5 h-3.5 w-3.5 shrink-0 rotate-180 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          </span>
        ) : null}
        {files.map((file) => (
          <span
            key={file.path}
            data-testid={withTestIds ? "landing-file-chip" : undefined}
            data-cub-anchor="file"
            className={file.active && artifactOpen ? chrome.CHIP_FILE_ACTIVE : chrome.CHIP_FILE}
            title={file.path}
          >
            <span className="max-w-56 truncate">{basename(file.path)}</span>
            <LineDelta added={file.added} removed={file.removed} loading={loading} testId={withTestIds ? "landing-file-delta" : undefined} />
          </span>
        ))}
        <span className={chrome.FILE_RAIL_DIVIDER} aria-hidden="true" />
        {/* Landing-only: the two actions wrap together, so a narrow column
            never leaves Undo alone on a line. */}
        <span className="inline-flex max-w-full items-center gap-x-1.5">
          <span className={chrome.ACTION_CHIP}>
            <Eye className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
            <span>Review changes</span>
          </span>
          <span className={chrome.ACTION_CHIP}>
            <Undo className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
            <span>Undo</span>
          </span>
        </span>
      </div>
    </div>
  );
}

// ChatFileChangeList.tsx:909-1030: the open file card under the rail. A
// created file wears the Created badge and lists every line as an added row
// (there is no table preview, even for a .csv); an edit wears Updated and
// shows its hunk.
function FileCard({ scenario, withTestIds }: { scenario: SessionScenario; withTestIds: boolean }) {
  const activeFile = scenario.files.find((file) => file.active) ?? scenario.files[0];
  const card = scenario.card!;
  return (
    <div className={chrome.DIFF_CARD} data-testid={withTestIds ? "landing-diff-card" : undefined} data-change={card.change}>
      <div className={chrome.DIFF_CARD_HEADER}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={card.change === "created" ? chrome.DIFF_BADGE_CREATED : chrome.DIFF_BADGE_UPDATED}>
            {card.change === "created" ? "Created" : "Updated"}
          </span>
          <span className={chrome.DIFF_FILENAME}>{basename(activeFile.path)}</span>
        </div>
        <div className={chrome.DIFF_GLYPHS}>
          <OpenNewWindow className="h-3 w-3" aria-hidden="true" />
          <Undo className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      </div>
      <div className={chrome.DIFF_BODY}>
        {card.rows.map((row, index) => (
          <div
            key={index}
            data-testid={withTestIds ? "landing-diff-row" : undefined}
            className={`${chrome.DIFF_ROW} ${getUnifiedDiffRowClass({ ...row, oldLine: null, newLine: null })}`}
          >
            {row.text.length > 0 ? row.text : " "}
          </div>
        ))}
      </div>
    </div>
  );
}

// ChatMessageContent.tsx renders a message's prose with its inline code, its
// workspace file reference chips (folder, then name and line) and its links.
// The reference wears its hover tone (it has no other pressed state) from just
// before Ada's click opens it beside the chat.
function MessageParts({ parts, referenceOpen, withTestIds }: { parts: readonly MessagePart[]; referenceOpen: boolean; withTestIds: boolean }) {
  return (
    <>
      {parts.map((part, index) => {
        if (typeof part === "string") return <Fragment key={index}>{part}</Fragment>;
        if ("code" in part) {
          return (
            <code key={index} className={chrome.INLINE_CODE}>
              {part.code}
            </code>
          );
        }
        if ("file" in part) {
          const slash = part.file.lastIndexOf("/");
          return (
            <span
              key={index}
              data-testid={withTestIds ? "landing-file-reference" : undefined}
              data-open={referenceOpen ? "true" : "false"}
              className={`${chrome.FILE_REFERENCE}${referenceOpen ? ` ${chrome.FILE_REFERENCE_HOVER}` : ""}`}
            >
              <span className="flex min-w-0 max-w-full items-baseline">
                {slash >= 0 ? <span className={chrome.FILE_REFERENCE_FOLDER}>{part.file.slice(0, slash + 1)}</span> : null}
                <span className={chrome.FILE_REFERENCE_NAME}>
                  {part.file.slice(slash + 1)}
                  {part.line ? `:${part.line}` : ""}
                </span>
              </span>
            </span>
          );
        }
        return (
          <span key={index} className={chrome.MESSAGE_LINK} data-testid={withTestIds ? "landing-message-link" : undefined}>
            {part.link}
          </span>
        );
      })}
    </>
  );
}

// ChatActionCard.tsx as the runtime's browser request draws it
// (runtime-agent/src/jobs/browser_request.rs): Ada's press goes down on the
// button (Button.tsx's pressed state), then while it opens the browser the
// button is busy ("Opening browser…", a spinner, disabled); once the
// continuation is sent it is itself again.
function BrowserRequestCard({
  pressed,
  busy,
  playing,
  withTestIds,
}: {
  pressed: boolean;
  busy: boolean;
  playing: boolean;
  withTestIds: boolean;
}) {
  return (
    <Surface tone="default" radius="2xl" shadow="sm" className={chrome.ACTION_CARD} data-testid={withTestIds ? "landing-browser-request" : undefined}>
      <div className="space-y-1">
        <Text as="div" variant="bodyStrong" tone="primary">
          Continue in browser
        </Text>
        <Text as="div" variant="caption" tone="muted" className="leading-snug">
          Open your browser and let the AI continue this task there.
        </Text>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          data-testid={withTestIds ? "landing-browser-request-button" : undefined}
          data-busy={busy ? "true" : "false"}
          data-pressed={pressed ? "true" : "false"}
          className={`${chrome.BUTTON_PRIMARY}${pressed ? ` ${chrome.BUTTON_PRIMARY_PRESSED}` : ""}${busy ? ` ${chrome.BUTTON_DISABLED}` : ""}`}
        >
          {busy && playing ? <Spinner aria-hidden="true" tone="primary" size="sm" /> : null}
          {busy ? "Opening browser…" : "Open browser and continue"}
        </span>
      </div>
    </Surface>
  );
}

const THREAD_ROOT_STYLE = {
  paddingLeft: 4,
  "--thread-spine-left": chrome.THREAD_SPINE_LEFT,
} as CSSProperties;

function TeammateMessage({ text }: { text: string }) {
  return (
    <div className={chrome.SHELL_MESSAGE}>
      <div className={chrome.SHELL_MESSAGE_BODY}>{text}</div>
    </div>
  );
}

interface RunTestIds {
  avatar: string;
  thread: string;
  typing: string;
  rail: string;
  chip: string;
  spinner: string;
  caption: string;
  owner: string;
  summary: string;
}

const RUN_TEST_IDS: RunTestIds = {
  avatar: "landing-octo-working",
  thread: "landing-octo-thread",
  typing: "landing-typing-line",
  rail: "landing-run-rail",
  chip: "landing-run-chip",
  spinner: "landing-run-spinner",
  caption: "landing-run-caption",
  owner: "landing-owner-badge",
  summary: "landing-summary",
};

const BROWSE_TEST_IDS: RunTestIds = {
  avatar: "landing-browse-working",
  thread: "landing-browse-thread",
  typing: "landing-browse-typing",
  rail: "landing-browse-rail",
  chip: "landing-browse-chip",
  spinner: "landing-browse-spinner",
  caption: "landing-browse-caption",
  owner: "landing-browse-owner",
  summary: "landing-browse-summary",
};

/**
 * One of Octo's runs, the agent job thread preview in its compact form (the
 * chat column is always under 760px, threadPreviewHelpers.tsx): the typing
 * line, the activity rail with one chip per step and the live step's caption,
 * then the summary and whatever the run left (sections), joined by the spine.
 */
function OctoRun({
  steps,
  stepBeats,
  thinkingBeat,
  doneBeat,
  beat,
  playing,
  summary,
  sections,
  completeBeat,
  ids,
  withTestIds,
  messageAnchor,
}: {
  steps: readonly TurnStep[];
  /** The beat each step's chip lands on. */
  stepBeats: readonly number[];
  thinkingBeat: number;
  doneBeat: number;
  beat: number;
  playing: boolean;
  summary: ReactNode;
  sections?: ReactNode;
  /** The beat the run's last section is drawn on (the spine waits for it). */
  completeBeat: number;
  ids: RunTestIds;
  withTestIds: boolean;
  /** Cub's eyes follow this message (data-cub-anchor="octo-message"). */
  messageAnchor?: boolean;
}) {
  const done = beat >= doneBeat;
  const started = beat >= thinkingBeat;
  const runLive = playing && started && !done;
  const octoMotion: OctoMarkMotion = runLive ? "thinking" : "idle";
  const visibleChips = stepBeats.filter((at) => beat >= at).length;
  const newestChip = visibleChips - 1;
  const liveStep = playing && !done && visibleChips > 0 ? steps[newestChip] : null;
  const commandLive = liveStep?.kind === "command";
  const showTypingLine = runLive && visibleChips === 0;
  const threadComplete = beat >= completeBeat;
  const testId = (name: string) => (withTestIds ? name : undefined);
  const renderChips = (from: number, to: number) =>
    steps.slice(from, to).map((step, offset) => {
      const index = from + offset;
      const shown = index < visibleChips;
      const live = playing && shown && index === newestChip && !done && !commandLive;
      return (
        <span
          key={index}
          data-testid={testId(ids.chip)}
          className={[
            chrome.RAIL_CHIP,
            playing && shown ? "instafy-compact-event-pill" : "",
            live ? "instafy-compact-event-pill-live" : "",
            shown ? "" : "invisible",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <StepGlyph kind={step.kind} ownerHandle={step.ownerHandle} />
        </span>
      );
    });

  return (
    <ChatBubbleRow
      align="left"
      avatar={
        <Reveal visible={started} className={chrome.THREAD_AVATAR}>
          <OctoAvatar size="sm" motion={octoMotion} pop={playing && done} testId={testId(ids.avatar)} />
        </Reveal>
      }
      speakerIdentity={
        <Reveal visible={started}>
          <SpeakerLabel name="octo" time="now" />
        </Reveal>
      }
      speakerMarker={null}
    >
      <div className={chrome.THREAD_ROOT} style={THREAD_ROOT_STYLE}>
        <div className={chrome.THREAD_BODY} data-testid={testId(ids.thread)} data-cub-anchor={messageAnchor ? "octo-message" : undefined}>
          {/* The rail row and the live caption each draw their own
              full-height stem, so while the run is live the line ends at the
              caption. The bridging spine that joins summary, file rail and
              artifact spans the body's full height, which is already the
              run's final height, so it waits for the last section to be
              drawn; otherwise it would run on down through the sections
              still laid out invisibly below. */}
          <ThreadSpine
            tone="primary"
            className={`${chrome.THREAD_SPINE_MAIN} ${threadComplete ? "opacity-100" : "opacity-0"}`}
            style={{ top: "32px", bottom: "16px" }}
          />

          {/* Slot A: the typing line, then the chip rail in the same cell. */}
          <div className="grid min-w-0">
            {showTypingLine ? (
              <div aria-hidden="true" data-pin="" className={`[grid-area:1/1] min-w-0 ${chrome.TYPING_LINE}`} data-testid={testId(ids.typing)}>
                <span className={chrome.TYPING_LINE_TEXT} data-sweep-text="Thinking…">
                  Thinking…
                </span>
              </div>
            ) : null}
            <Reveal visible={visibleChips > 0} className="[grid-area:1/1]">
              <div aria-hidden="true" className={chrome.RAIL_ROW}>
                <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} notches={[{ offsetPx: 16, maskLine: true }]} />
                <div className={chrome.RAIL_ROW_INNER}>
                  <div className={chrome.RAIL_ROW_TRACK}>
                    {/* The rail is drawn in three parts so the in-flight
                        spinner sits immediately after the last drawn chip, the
                        way the studio's own rail appends it, while the chips
                        still to come keep their width in reserve behind it.
                        One extra reserved slot stands in for the spinner, so
                        the rail is the same width at every beat whether or not
                        a command is in flight. Chips arrive one at a time here,
                        so none of them carries the studio's cascade delay: the
                        newest chip and the spinner beside it appear together. */}
                    <div className={chrome.RAIL_CHIPS} data-testid={testId(ids.rail)}>
                      {renderChips(0, visibleChips)}
                      {commandLive ? (
                        <span
                          data-testid={testId(ids.spinner)}
                          className={`${chrome.RAIL_CHIP} instafy-compact-event-pill instafy-compact-event-pill-live`}
                        >
                          <Spinner size="xs" tone="slate" className="h-3.5 w-3.5" />
                        </span>
                      ) : (
                        <span className={`${chrome.RAIL_CHIP} invisible`} aria-hidden="true" />
                      )}
                      {renderChips(visibleChips, steps.length)}
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>

          {/* Slot B: the live caption, then the summary in the same cell. */}
          <div className="grid min-w-0 items-start">
            {liveStep ? (
              <div aria-hidden="true" data-pin="" className={`[grid-area:1/1] min-w-0 ${chrome.CAPTION_SECTION}`}>
                <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} notches={[{ offsetPx: 9, maskLine: true }]} />
                <div className={chrome.CAPTION_ROW}>
                  {liveStep.ownerHandle ? (
                    <span className={chrome.OWNER_BADGE} data-testid={testId(ids.owner)}>
                      {liveStep.ownerHandle}
                    </span>
                  ) : null}
                  <span className={chrome.CAPTION_TEXT} data-sweep-text={liveStep.caption} data-testid={testId(ids.caption)}>
                    {liveStep.caption}
                  </span>
                </div>
              </div>
            ) : null}
            <Reveal visible={done} className="[grid-area:1/1]" testId={testId(ids.summary)}>
              <div className={chrome.SUMMARY_SECTION}>
                <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} notches={[{ offsetPx: 9, maskLine: true }]} />
                <div className="min-w-0">
                  <div className={chrome.SUMMARY_STACK}>
                    <div className={chrome.MESSAGE_CONTENT}>
                      <p className={chrome.MESSAGE_PARAGRAPH}>{summary}</p>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>

          {sections}

          {/* The closing stub sits at the foot of the body, which is already
              the run's final height, so like the bridging spine it waits for
              the last section rather than hanging in empty space. */}
          <Reveal visible={threadComplete}>
            <div className={chrome.END_STUB}>
              <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} segments={[{ topPx: -1, heightPx: 6 }]} />
            </div>
          </Reveal>
        </div>
      </div>
    </ChatBubbleRow>
  );
}

/**
 * How far the transcript column has scrolled so its newest drawn content sits
 * at the bottom of the transcript, the way the chat stays pinned to its newest
 * message: nothing while everything fits.
 */
export function transcriptScrollOffset(contentBottom: number, viewportHeight: number): number {
  return Math.max(0, Math.round(contentBottom - viewportHeight));
}

/**
 * Keeps the active scenario's newest message in view (TRANSCRIPT_SCROLL).
 * Every row is laid out at its final size from the first paint, so the
 * newest drawn content is the lowest element that is shown at this beat.
 */
function useTranscriptScroll(active: boolean, beat: number) {
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const column = columnRef.current;
    const viewport = column?.closest<HTMLElement>("[data-transcript-viewport]");
    if (!column || !viewport || !active) {
      setOffset(0);
      return;
    }
    const update = () => {
      const top = column.getBoundingClientRect().top;
      let bottom = 0;
      column.querySelectorAll<HTMLElement>('[data-beat-visible="true"], [data-pin]').forEach((node) => {
        // A reveal inside a hidden one is not shown yet.
        if (node.parentElement?.closest('[data-beat-visible="false"]')) return;
        bottom = Math.max(bottom, node.getBoundingClientRect().bottom - top);
      });
      const style = getComputedStyle(viewport);
      const height = viewport.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
      const next = transcriptScrollOffset(bottom, height);
      setOffset((current) => (current === next ? current : next));
    };
    update();
    if (typeof ResizeObserver !== "function") return;
    // The transcript's size, and the column's own (a web font swapping in
    // rewraps every message).
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(column);
    return () => observer.disconnect();
  }, [active, beat]);
  return { columnRef, offset: active ? offset : 0 };
}

// One scripted task for one scenario, drawn for a beat. When playing is false
// the beat is the scenario's last and nothing transient exists in the DOM.
export function TurnColumn({
  scenario,
  beat,
  playing,
  withTestIds = false,
  split = true,
}: {
  scenario: SessionScenario;
  beat: number;
  playing: boolean;
  withTestIds?: boolean;
  /**
   * The window shows a split: only there does Ada click the summary's file
   * reference to open the result beside the chat (one view keeps the chat in
   * front, with the result in its inline card).
   */
  split?: boolean;
}) {
  const at = (id: TurnBeatId) => beatReached(scenario, beat, id);
  const index = (id: TurnBeatId) => beatIndex(scenario, id);
  const browser = scenario.browser;
  const artifactOpen = beat >= BEAT.ARTIFACT;
  const countsLoading = playing && beat < BEAT.COUNTS;
  const showKimTyping = playing && at("kimTyping") && !at("reply");
  const testId = (name: string) => (withTestIds ? name : undefined);
  const { columnRef, offset } = useTranscriptScroll(withTestIds, beat);
  // The run's last section: the file card, the browser request, or, for a
  // scenario whose result is only its files, the file rail.
  const runOneComplete = scenario.card || browser ? BEAT.ARTIFACT : BEAT.FILES;
  // Ada's pointer is on the reference from the counts beat, 400 ms before her
  // click opens the file on the artifact beat, so the file never opens on its
  // own.
  const fileReferenceOpen = split && beat >= BEAT.COUNTS && !!scenario.pane.artifact && !scenario.pane.artifact.sameTab;

  return (
    <div className="relative flex flex-col">
      {/* Cub's floor, which his front arms hang to: 16px under the window's
          top bar, where the conversation began before the views bar (45px,
          md+) came between them, so his arms stay in the top bar's band and
          off the views. It never moves with the transcript's scroll. */}
      <div aria-hidden="true" data-cub-anchor="floor" className={`pointer-events-none absolute inset-x-0 top-0 h-[50px] ${chrome.VIEWS_BAR_FLOOR_LIFT}`} />
      <div ref={columnRef} data-testid={testId("landing-transcript-column")} data-scroll={offset} className={chrome.TRANSCRIPT_SCROLL} style={offset ? { transform: `translateY(-${offset}px)` } : undefined}>
        <ChatColumn className="space-y-2.5">
          {/* Row 1: Kim's opener (a teammate: flat text, never a bubble). */}
          <div data-pin="">
            <ChatBubbleRow
              align="left"
              avatar={<CrewAvatar initial="K" crew={KIM} size="sm" />}
              speakerIdentity={<SpeakerLabel name="Kim" time="4m ago" />}
              speakerMarker={null}
              testId={testId("landing-opener")}
            >
              <TeammateMessage text={scenario.opener} />
            </ChatBubbleRow>
          </div>

          {/* Row 2: Ada's own message. The app never labels your own message. */}
          <ChatBubbleRow align="right" avatar={null} speakerMarker={null}>
            {/* The wrapper spans the column so the bubble's 92% cap resolves
                against it, exactly as the bare bubble does in the app. */}
            <Reveal visible={beat >= BEAT.OWN} className="flex w-full justify-end">
              <div data-testid={testId("landing-own-message")} data-cub-anchor="own" className={chrome.OWN_BUBBLE}>
                {scenario.prompt}
              </div>
            </Reveal>
          </ChatBubbleRow>

          {/* Row 3: Octo's run, the agent job thread preview. The app shows no
              assistant row until Octo starts, so the avatar fades in with its
              label (the slot is a fixed 32px box, so nothing moves). */}
          <OctoRun
            steps={scenario.steps}
            stepBeats={[BEAT.STEP1, BEAT.STEP2, BEAT.STEP3, BEAT.STEP4, BEAT.STEP5]}
            thinkingBeat={BEAT.THINKING}
            doneBeat={BEAT.DONE}
            beat={beat}
            playing={playing}
            summary={<MessageParts parts={scenario.summaryParts} referenceOpen={fileReferenceOpen} withTestIds={withTestIds} />}
            completeBeat={runOneComplete}
            ids={RUN_TEST_IDS}
            withTestIds={withTestIds}
            messageAnchor
            sections={
              <>
                {/* The file rail and, for an artifact, its open card or the browser request. */}
                <Reveal visible={beat >= BEAT.FILES}>
                  <div className="relative pt-1">
                    <div className="min-w-0">
                      <FileRail
                        files={scenario.files}
                        railLabel={scenario.railLabel}
                        loading={countsLoading}
                        artifactOpen={artifactOpen}
                        withTestIds={withTestIds}
                      />
                    </div>
                  </div>
                </Reveal>
                {scenario.card ? (
                  <Reveal visible={artifactOpen}>
                    <FileCard scenario={scenario} withTestIds={withTestIds} />
                  </Reveal>
                ) : null}
                {browser ? (
                  <Reveal visible={artifactOpen} className="mt-2.5">
                    <BrowserRequestCard
                      pressed={at("tap") && !at("press")}
                      busy={at("press") && !at("handoff")}
                      playing={playing}
                      withTestIds={withTestIds}
                    />
                  </Reveal>
                ) : null}
              </>
            }
          />

          {browser ? (
            <>
              {/* Row 4: the continuation Ada's press sends as her own message
                  (browserRequestContinuation), which starts the browser turn. */}
              <ChatBubbleRow align="right" avatar={null} speakerMarker={null}>
                <Reveal visible={at("handoff")} className="flex w-full justify-end">
                  <div data-testid={testId("landing-continuation")} className={`${chrome.OWN_BUBBLE} whitespace-pre-wrap`}>
                    {browserContinuation(browser.task)}
                  </div>
                </Reveal>
              </ChatBubbleRow>

              {/* Row 5: Octo's browser run. Every Shared Browser step is a
                  tool call, so its rail shows tool chips captioned "Calling
                  tool…"; what Octo does on the page is captioned in the
                  browser beside the chat. */}
              <OctoRun
                steps={browser.steps}
                stepBeats={[index("approve"), index("loaded"), index("scroll"), index("click")]}
                thinkingBeat={index("browse")}
                doneBeat={index("browseDone")}
                beat={beat}
                playing={playing}
                summary={browser.summary}
                completeBeat={index("browseDone")}
                ids={BROWSE_TEST_IDS}
                withTestIds={withTestIds}
              />
            </>
          ) : null}

          {/* Last row, one cell: Kim typing, then Kim's reply. */}
          <div className="grid min-w-0">
            {showKimTyping ? (
              <div aria-hidden="true" data-pin="" className={`[grid-area:1/1] min-w-0 ${chrome.PEER_TYPING_ROW}`}>
                <CrewAvatar initial="K" crew={KIM} size="sm" />
                <ChatActivityBubble
                  aria-live="off"
                  testId="landing-kim-typing"
                  width="peer"
                  density="comfortable"
                  dotSize="md"
                  surfaceTone="default"
                  label="Kim is typing…"
                />
              </div>
            ) : null}
            <Reveal visible={at("reply")} className="[grid-area:1/1]" testId={testId("landing-kim-reply")}>
              <ChatBubbleRow
                align="left"
                avatar={<CrewAvatar initial="K" crew={KIM} size="sm" />}
                speakerIdentity={<SpeakerLabel name="Kim" time="now" />}
                speakerMarker={null}
              >
                <TeammateMessage text={scenario.reply} />
              </ChatBubbleRow>
            </Reveal>
          </div>
        </ChatColumn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer

// The typewriter owns the only interval in the deck, so only its span
// re-renders while Ada types. Single-line and truncating: the real editor
// wraps, this one keeps the composer at 48px at every width.
function TypedPrompt({ text, typing, held }: { text: string; typing: boolean; held: boolean }) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!typing) return;
    const step = Math.max(1, Math.ceil(text.length / TYPEWRITER_TICKS));
    let count = Math.min(text.length, step);
    setTyped(text.slice(0, count));
    const timer = setInterval(() => {
      count = Math.min(text.length, count + step);
      setTyped(text.slice(0, count));
      if (count >= text.length) clearInterval(timer);
    }, TYPEWRITER_TICK_MS);
    return () => clearInterval(timer);
  }, [text, typing]);

  useEffect(() => {
    if (held) {
      setTyped(text);
    } else if (!typing) {
      setTyped("");
    }
  }, [held, text, typing]);

  return (
    <span aria-hidden="true" data-testid="landing-typed-prompt" className={chrome.TYPED_TEXT}>
      {typed}
      {typing ? <span className={chrome.CARET} /> : null}
    </span>
  );
}

// ChatComposerSurface.tsx:1301-1370 at rest: "+" and the mic, the placeholder
// "Ask for something…", and Send taking the mic's slot while a draft exists.
// On phones the conversation's views sit above it (viewNavigation, 1345).
export function MiniComposer({
  prompt,
  beat,
  playing,
  viewNavigation,
}: {
  prompt: string;
  beat: number;
  playing: boolean;
  viewNavigation?: ReactNode;
}) {
  const typing = playing && beat === BEAT.TYPING;
  const held = playing && beat === BEAT.SEND;
  const draft = typing || held;
  return (
    <div aria-hidden="true" data-landing-composer="" className={chrome.COMPOSER_WRAP}>
      {viewNavigation ? <div className={CHAT_COLUMN_CLASS_NAME}>{viewNavigation}</div> : null}
      <div className={CHAT_COLUMN_CLASS_NAME} data-cub-anchor="composer">
        <Surface tone="default" radius="3xl" shadow="none" className={chrome.COMPOSER_SURFACE}>
          <div className={chrome.COMPOSER_ROW}>
            <div className={chrome.COMPOSER_LEADING}>
              {/* The phone composer's navigation button, without its Home unread badge. */}
              <span className={`md:hidden ${chrome.GHOST_ACTION}`}>
                <Menu className={chrome.COMPOSER_ICON} aria-hidden="true" />
              </span>
              <span className={chrome.GHOST_ACTION}>
                <Plus className={chrome.COMPOSER_ICON} aria-hidden="true" />
              </span>
            </div>
            <div className={chrome.COMPOSER_EDITOR}>
              <div className="relative h-5">
                <span className={`${chrome.PLACEHOLDER}${draft ? " invisible" : ""}`}>Ask for something…</span>
                <TypedPrompt text={prompt} typing={typing} held={held} />
              </div>
            </div>
            <div className={chrome.COMPOSER_TRAILING}>
              {draft ? (
                <span className={`${chrome.SEND_PRIMARY}${held ? ` ${chrome.SEND_PRESSED}` : ""}`} data-testid="landing-composer-send">
                  <Send className={chrome.COMPOSER_ICON} aria-hidden="true" />
                </span>
              ) : (
                <span className={chrome.GHOST_ACTION} data-testid="landing-composer-mic">
                  <Microphone className={chrome.COMPOSER_ICON} aria-hidden="true" />
                </span>
              )}
            </div>
          </div>
        </Surface>
      </div>
    </div>
  );
}
