import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  Bell,
  ChatLines,
  CheckCircle,
  ClipboardCheck,
  Coins,
  Eye,
  GitBranch,
  Menu,
  Microphone,
  MoreHoriz,
  NavArrowLeft,
  NavArrowRight,
  OpenNewWindow,
  Page,
  Plus,
  Refresh,
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
import { OctoMark, type OctoMarkMotion } from "../../components/OctoMark";
import { Spinner } from "../../components/Spinner";
import { Surface } from "../../components/Surface";
import { Text } from "../../components/Text";
import { getUnifiedDiffRowClass } from "../../utils/unifiedDiff";
import { BrowserChromeShell } from "../studio/components/BrowserChromeShell";
import { ChatActivityBubble } from "../studio/components/ChatActivityBubble";
import { ChatBubbleRow } from "../studio/components/ChatBubbleRow";
import { CHAT_COLUMN_CLASS_NAME, ChatColumn } from "../studio/components/ChatColumn";
import { SidebarOrgDeck } from "../studio/components/SidebarOrgDeck";
import { ThreadSpine } from "../studio/components/ThreadSpine";
import * as chrome from "./landingStudioChrome";
import {
  BEAT,
  TYPEWRITER_TICK_MS,
  TYPEWRITER_TICKS,
  type SessionScenario,
  type TurnFile,
  type TurnStepKind,
} from "./landingTurnScript";

// Crew colours, one per actor, as inline styles (Tailwind never sees them).
const ADA_COLOR = "#e93d82";
const KIM_COLOR = "#8cb93b";
const AGENT_COLOR = "#7c4dd8";

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

// ChatMessageAvatar.tsx:96-140 for a human: the crew hex stands in for the
// seeded gradient so Ada and Kim keep one colour across the whole page.
function CrewAvatar({ initial, color, size }: { initial: string; color: string; size: "2xs" | "sm" }) {
  return (
    <span
      aria-hidden="true"
      className={`${chrome.AVATAR_SHELL} ${size === "2xs" ? chrome.AVATAR_2XS : chrome.AVATAR_SM} ${chrome.AVATAR_HUMAN}`}
      style={{ backgroundColor: color }}
    >
      {initial}
    </span>
  );
}

// ChatMessageAvatar.tsx:140-149: the brand-ink mark on a white coin in both
// themes. A tinted wrapper turns the mark into the scenario agent (always
// idle: custom agents never get Octo's motion).
function OctoAvatar({
  size,
  motion = "idle",
  tint,
  title = "Octo",
  testId,
}: {
  size: "2xs" | "sm";
  motion?: OctoMarkMotion;
  tint?: string;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={`${chrome.AVATAR_SHELL} ${size === "2xs" ? chrome.AVATAR_2XS : chrome.AVATAR_SM} bg-white`}
      style={tint ? { color: tint } : undefined}
    >
      <span className={chrome.OCTO_COIN}>
        <OctoMark className={tint ? chrome.OCTO_MARK_TINTED : chrome.OCTO_MARK} motion={motion} title={title} />
      </span>
    </span>
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
}: {
  scenarios: SessionScenario[];
  active: number;
  runLive: boolean;
}) {
  return (
    <nav aria-hidden="true" data-testid="landing-rail" className={`hidden lg:flex w-56 ${chrome.RAIL_SURFACE}`}>
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
                  Launch week
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
          <span className={chrome.PROFILE_AVATAR} style={{ backgroundColor: ADA_COLOR }}>
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

function CollapsedRow({ active = false, children }: { active?: boolean; children: ReactNode }) {
  return (
    <li className="flex justify-center">
      <span className={chrome.ROW_COLLAPSED}>
        <span className={`${chrome.SHELL_COLLAPSED} ${active ? chrome.SHELL_COLLAPSED_ACTIVE : chrome.SHELL_INACTIVE}`}>{children}</span>
      </span>
    </li>
  );
}

// StudioSidebar.tsx between md and lg: the 64px icon rail at compact density
// (the frame is under 760px tall), with the blue Chats tile active.
export function RailCollapsed() {
  return (
    <nav aria-hidden="true" className={`hidden md:flex lg:hidden w-[4rem] ${chrome.RAIL_SURFACE}`}>
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
        <CollapsedRow>
          <GitBranch className="text-base" aria-hidden="true" />
        </CollapsedRow>
        <CollapsedRow>
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
    <div aria-hidden="true" className={chrome.TAB_STRIP}>
      <span className={chrome.TAB_BASELINE} />
      <div className="relative flex min-w-0 flex-1 items-end">
        <span className={chrome.TAB_ACTIVE}>
          <span className={chrome.TAB_CONTENT}>
            <ChatLines className="h-5 w-5" aria-hidden="true" />
            {title}
          </span>
          <span className={chrome.TAB_CLOSE}>
            <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </span>
        <span className={chrome.TAB_ACTION}>
          <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
      </div>
      <div className={chrome.TAB_ACTIONS}>
        <span className={chrome.TAB_BELL}>
          <Bell className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className={chrome.TAB_ACTION}>
          <MoreHoriz className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

// StudioTopBar.tsx:521-560 below md: toggle, the pill tab, bell and "+".
export function MiniPhoneBar({ title }: { title: ReactNode }) {
  return (
    <div aria-hidden="true" className={chrome.PHONE_BAR}>
      <span className={chrome.PHONE_ROUND_ACTION}>
        <SidebarExpand className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 justify-start">
        <span className={chrome.PHONE_PILL}>
          <ChatLines className="h-4 w-4 shrink-0" aria-hidden="true" />
          {title}
        </span>
      </div>
      <div className="flex items-center">
        <span className={chrome.PHONE_ROUND_ACTION}>
          <Bell className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className={chrome.PHONE_ROUND_ACTION}>
          <Plus className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster

// ChatPanel.tsx:5561-5575 + ConversationRoster.tsx:92-103: humans first, then
// agents. The scenario agent's slot is laid out from the first frame and
// slides in at step4.
export function RosterStack({ scenario, agentVisible }: { scenario: SessionScenario; agentVisible: boolean }) {
  return (
    <div aria-hidden="true" className={chrome.ROSTER_ROW}>
      <ChatColumn className="flex items-center justify-end gap-2">
        <span className={chrome.ROSTER_HANDLE}>
          <span className={chrome.ROSTER_STACK}>
            <span className={chrome.ROSTER_RING}>
              <CrewAvatar initial="A" color={ADA_COLOR} size="2xs" />
            </span>
            <span className={chrome.ROSTER_RING}>
              <CrewAvatar initial="K" color={KIM_COLOR} size="2xs" />
            </span>
            <span className={chrome.ROSTER_RING}>
              <OctoAvatar size="2xs" />
            </span>
            <span
              data-testid="landing-roster-agent"
              data-beat-visible={agentVisible ? "true" : "false"}
              className={`${chrome.ROSTER_RING} ${chrome.REVEAL_BASE} ${agentVisible ? chrome.REVEAL_SLIDE_SHOWN : chrome.REVEAL_SLIDE_HIDDEN}`}
            >
              <OctoAvatar size="2xs" tint={AGENT_COLOR} title={scenario.presenceAgent} />
            </span>
          </span>
        </span>
      </ChatColumn>
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
            className={file.active && artifactOpen ? chrome.CHIP_FILE_ACTIVE : chrome.CHIP_FILE}
            title={file.path}
          >
            <span className="max-w-56 truncate">{basename(file.path)}</span>
            <LineDelta added={file.added} removed={file.removed} loading={loading} testId={withTestIds ? "landing-file-delta" : undefined} />
          </span>
        ))}
        <span className={chrome.FILE_RAIL_DIVIDER} aria-hidden="true" />
        <span className={chrome.ACTION_CHIP}>
          <Eye className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>Review changes</span>
        </span>
        <span className={chrome.ACTION_CHIP}>
          <Undo className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>Undo</span>
        </span>
      </div>
    </div>
  );
}

// ChatFileChangeList.tsx:909-1030: the open file card under the rail.
function DiffCard({ scenario, withTestIds }: { scenario: SessionScenario; withTestIds: boolean }) {
  const activeFile = scenario.files.find((file) => file.active) ?? scenario.files[0];
  return (
    <div className={chrome.DIFF_CARD} data-testid={withTestIds ? "landing-diff-card" : undefined}>
      <div className={chrome.DIFF_CARD_HEADER}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={chrome.DIFF_BADGE_UPDATED}>Updated</span>
          <span className={chrome.DIFF_FILENAME}>{basename(activeFile.path)}</span>
        </div>
        <div className={chrome.DIFF_GLYPHS}>
          <OpenNewWindow className="h-3 w-3" aria-hidden="true" />
          <Undo className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      </div>
      <div className={chrome.DIFF_BODY}>
        {(scenario.diffRows ?? []).map((row, index) => (
          <div
            key={index}
            data-testid={withTestIds ? "landing-diff-row" : undefined}
            className={`${chrome.DIFF_ROW} ${getUnifiedDiffRowClass({ ...row, oldLine: null, newLine: null })}`}
          >
            {row.text.length > 0 ? row.text : "\u00a0"}
          </div>
        ))}
      </div>
    </div>
  );
}

// BrowserStatusPill (BrowserChromeShell.tsx:14-50) as a plain span. The
// spinner only turns while the dock is on screen; before that a blank of the
// same size holds the pill's width, so the toolbar row never changes height
// when the dock fades in.
function StatusPillReplica({ state, spinning }: { state: "ready" | "starting"; spinning: boolean }) {
  return state === "ready" ? (
    <span className={`${chrome.STATUS_PILL} ${chrome.STATUS_PILL_READY}`}>
      <CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Ready</span>
    </span>
  ) : (
    <span className={`${chrome.STATUS_PILL} ${chrome.STATUS_PILL_STARTING}`}>
      {spinning ? (
        <Spinner aria-hidden="true" tone="slate" size="xs" />
      ) : (
        <span className="inline-block h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      <span>Starting…</span>
    </span>
  );
}

// A static rendering of the pricing page the site scenario publishes. The dock
// keeps the real 16:9 stage at every width, so the page takes a size step on a
// phone (where the stage is about 270 x 152) the way a screencast would scale,
// rather than overflowing the stage and being clipped.
function PricingPage() {
  return (
    <div className="px-3 pt-2.5 sm:px-5 sm:pt-4">
      <p className="text-3xs font-semibold uppercase tracking-[0.12em] text-slate-500 sm:text-xxs">Forma</p>
      <p className="mt-1 text-sm font-semibold leading-tight sm:text-lg">Room for your next idea.</p>
      <p className="mt-0.5 text-3xs text-slate-500 sm:text-xs">Simple plans. Space to grow.</p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:mt-3 sm:gap-2">
        <div className="rounded-lg border border-slate-200 p-2 sm:p-2.5">
          <p className="text-3xs font-medium text-slate-600 sm:text-xs">Starter</p>
          <p className="mt-0.5 text-sm font-semibold leading-5 sm:mt-1 sm:text-lg sm:leading-6">$19</p>
          <p className="text-3xs text-slate-500 sm:text-xxs">per month</p>
        </div>
        <div className="rounded-lg border border-primary-500 p-2 ring-1 ring-primary-500/30 sm:p-2.5">
          <p className="text-3xs font-medium text-slate-600 sm:text-xs">Team</p>
          <p className="mt-0.5 text-sm font-semibold leading-5 sm:mt-1 sm:text-lg sm:leading-6">$49</p>
          <p className="text-3xs text-slate-500 sm:text-xxs">per month</p>
        </div>
      </div>
    </div>
  );
}

// ChatBrowserDock.tsx:40-60 mounts the docked BrowserSessionModal directly
// above the composer; this is that dock with the pricing page in its stage.
function BrowserDock({
  visible,
  beat,
  playing,
  withTestIds,
}: {
  visible: boolean;
  beat: number;
  playing: boolean;
  withTestIds: boolean;
}) {
  // The dock lands with the other artifacts, already Ready, so Octo's message
  // is complete before Kim reacts to it. The ticker runs for that one beat and
  // Kim's cursor glides onto the page just as Kim starts typing about it.
  const ready = beat >= BEAT.ARTIFACT;
  const glided = beat >= BEAT.KIM_TYPING;
  const ticker = playing && beat >= BEAT.ARTIFACT && beat < BEAT.KIM_TYPING;
  const navGlyph = "h-4 w-4";
  return (
    <Reveal visible={visible} className="relative z-30 mt-2.5" testId={withTestIds ? "landing-browser-dock" : undefined}>
      <div className={chrome.DOCK_WRAPPER}>
        <div aria-hidden="true">
          <BrowserChromeShell
            label="Shared browser"
            navigation={
              <>
                <span className={chrome.DOCK_NAV_GLYPH}>
                  <NavArrowLeft className={navGlyph} aria-hidden="true" />
                </span>
                <span className={chrome.DOCK_NAV_GLYPH}>
                  <NavArrowRight className={navGlyph} aria-hidden="true" />
                </span>
                <span className={chrome.DOCK_NAV_GLYPH}>
                  <Refresh className={navGlyph} aria-hidden="true" />
                </span>
              </>
            }
            address={
              <span className={chrome.ADDRESS_FIELD}>
                forma.site/pricing
                <span className={chrome.ADDRESS_GO}>
                  <Refresh className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </span>
            }
            status={<StatusPillReplica state={ready ? "ready" : "starting"} spinning={visible} />}
          />
        </div>
        {/* The real dock shows a remote screencast with no DOM text, so the
            stand-in page is hidden from assistive tech the same way. */}
        <div aria-hidden="true" className={chrome.DOCK_STAGE}>
          {ready ? <PricingPage /> : <div className="absolute inset-0 bg-slate-50" />}
          {/* Kim's cursor inside the shared browser (pre-#245 landing cursor, crew green). */}
          <span
            aria-hidden="true"
            className="absolute flex flex-col items-start transition-transform duration-500 ease-out motion-reduce:transition-none"
            // Parked low and left, under the Starter card, and anchored to the
            // stage's floor so the label always has room: over the price block
            // the arrow and the green pill sat across "$49" and "per month".
            style={{ left: "30%", bottom: "4%", transform: glided ? "translate(0,0)" : "translate(-40px,-28px)" }}
          >
            <svg className="h-4 w-4" viewBox="0 0 18 20">
              <path d="M2 1 L16 10 L9 11.5 L7 19 Z" fill={KIM_COLOR} stroke="#ffffff" strokeWidth="1.5" />
            </svg>
            <span className="mt-0.5 rounded-full px-1.5 py-0.5 text-3xs font-semibold text-white" style={{ backgroundColor: KIM_COLOR }}>
              Kim
            </span>
          </span>
          {ticker ? (
            <div aria-hidden="true" className={chrome.TICKER_OVERLAY}>
              <span className={chrome.TICKER_PILL}>
                <span className={chrome.TICKER_DOT} />
                Opened forma.site
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// The turn

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

// One scripted turn for one scenario, drawn for a beat. When playing is false
// the beat is END and nothing transient exists in the DOM.
export function TurnColumn({
  scenario,
  beat,
  playing,
  withTestIds = false,
}: {
  scenario: SessionScenario;
  beat: number;
  playing: boolean;
  withTestIds?: boolean;
}) {
  const site = scenario.id === "site";
  const done = beat >= BEAT.DONE;
  const runLive = playing && beat >= BEAT.THINKING && !done;
  const octoMotion: OctoMarkMotion = runLive ? "thinking" : "idle";
  const liveStepIndex = playing && beat >= BEAT.STEP1 && !done ? beat - BEAT.STEP1 : -1;
  const liveStep = liveStepIndex >= 0 ? scenario.steps[liveStepIndex] : null;
  const commandLive = liveStep?.kind === "command";
  const visibleChips = Math.max(0, Math.min(scenario.steps.length, beat - BEAT.STEP1 + 1));
  const newestChip = visibleChips - 1;
  const showTypingLine = playing && beat >= BEAT.THINKING && beat < BEAT.STEP1;
  const showKimTyping = playing && beat >= BEAT.KIM_TYPING && beat < BEAT.REPLY;
  const countsLoading = playing && beat < BEAT.COUNTS;
  const artifactOpen = beat >= BEAT.ARTIFACT;
  // The last section of Octo's message: the diff card, the docked browser, or,
  // for a scenario whose artifact is the code block inside the summary, the
  // file rail. The bridging spine waits for it (see below).
  const threadComplete = scenario.diffRows || site ? artifactOpen : beat >= BEAT.FILES;
  const testId = (name: string) => (withTestIds ? name : undefined);
  const renderChips = (from: number, to: number) =>
    scenario.steps.slice(from, to).map((step, offset) => {
      const index = from + offset;
      const shown = index < visibleChips;
      const live = playing && shown && index === newestChip && !done && !commandLive;
      return (
        <span
          key={index}
          data-testid={testId("landing-run-chip")}
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
    <div className="flex flex-col">
      <ChatColumn className="space-y-2.5">
        {/* Row 1: Kim's opener (a teammate: flat text, never a bubble). */}
        <ChatBubbleRow
          align="left"
          avatar={<CrewAvatar initial="K" color={KIM_COLOR} size="sm" />}
          speakerIdentity={<SpeakerLabel name="Kim" time="4m ago" />}
          speakerMarker={null}
        >
          <TeammateMessage text={scenario.opener} />
        </ChatBubbleRow>

        {/* Row 2: Ada's own message. The app never labels your own message. */}
        <ChatBubbleRow align="right" avatar={null} speakerMarker={null}>
          {/* The wrapper spans the column so the bubble's 92% cap resolves
              against it, exactly as the bare bubble does in the app. */}
          <Reveal visible={beat >= BEAT.OWN} className="flex w-full justify-end">
            <div data-testid={testId("landing-own-message")} className={chrome.OWN_BUBBLE}>
              {scenario.prompt}
            </div>
          </Reveal>
        </ChatBubbleRow>

        {/* Row 3: Octo's run, the agent job thread preview. The app shows no
            assistant row until Octo starts, so the avatar fades in with its
            label (the slot is a fixed 32px box, so nothing moves). */}
        <ChatBubbleRow
          align="left"
          avatar={
            <Reveal visible={beat >= BEAT.THINKING}>
              <OctoAvatar size="sm" motion={octoMotion} testId={testId("landing-octo-working")} />
            </Reveal>
          }
          speakerIdentity={
            <Reveal visible={beat >= BEAT.THINKING}>
              <SpeakerLabel name="octo" time="now" />
            </Reveal>
          }
          speakerMarker={null}
        >
          <div className={chrome.THREAD_ROOT} style={THREAD_ROOT_STYLE}>
            <div className={chrome.THREAD_BODY} data-testid={testId("landing-octo-thread")}>
              {/* The rail row and the live caption each draw their own
                  full-height stem, so while the run is live the line ends at
                  the caption. The bridging spine that joins summary, file
                  rail and artifact spans the body's full height, which is
                  already the turn's final height, so it waits for the last
                  section to be drawn; otherwise it would run on down through
                  the sections still laid out invisibly below. */}
              <ThreadSpine
                tone="primary"
                className={`${chrome.THREAD_SPINE_MAIN} ${threadComplete ? "opacity-100" : "opacity-0"}`}
                style={{ top: "32px", bottom: "16px" }}
              />

              {/* Slot A: the typing line, then the chip rail in the same cell. */}
              <div className="grid min-w-0">
                {showTypingLine ? (
                  <div aria-hidden="true" className={`[grid-area:1/1] min-w-0 ${chrome.TYPING_LINE}`} data-testid={testId("landing-typing-line")}>
                    <span className={chrome.TYPING_LINE_TEXT} data-sweep-text="Thinking…">
                      Thinking…
                    </span>
                  </div>
                ) : null}
                <Reveal visible={beat >= BEAT.STEP1} className="[grid-area:1/1]">
                  <div aria-hidden="true" className={chrome.RAIL_ROW}>
                    <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} notches={[{ offsetPx: 16, maskLine: true }]} />
                    <div className={chrome.RAIL_ROW_INNER}>
                      <div className={chrome.RAIL_ROW_TRACK}>
                        {/* The rail is drawn in three parts so the in-flight
                            spinner sits immediately after the last drawn chip,
                            the way the studio's own rail appends it, while the
                            chips still to come keep their width in reserve
                            behind it. One extra reserved slot stands in for the
                            spinner, so the rail is the same width at every beat
                            whether or not a command is in flight. Chips arrive
                            one at a time here, so none of them carries the
                            studio's cascade delay: the newest chip and the
                            spinner beside it appear together. */}
                        <div className={chrome.RAIL_CHIPS} data-testid={testId("landing-run-rail")}>
                          {renderChips(0, visibleChips)}
                          {commandLive ? (
                            <span
                              data-testid={testId("landing-run-spinner")}
                              className={`${chrome.RAIL_CHIP} instafy-compact-event-pill instafy-compact-event-pill-live`}
                            >
                              <Spinner size="xs" tone="slate" className="h-3.5 w-3.5" />
                            </span>
                          ) : (
                            <span className={`${chrome.RAIL_CHIP} invisible`} aria-hidden="true" />
                          )}
                          {renderChips(visibleChips, scenario.steps.length)}
                        </div>
                      </div>
                    </div>
                  </div>
                </Reveal>
              </div>

              {/* Slot B: the live caption, then the summary in the same cell. */}
              <div className="grid min-w-0 items-start">
                {liveStep ? (
                  <div aria-hidden="true" className={`[grid-area:1/1] min-w-0 ${chrome.CAPTION_SECTION}`}>
                    <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} notches={[{ offsetPx: 9, maskLine: true }]} />
                    <div className={chrome.CAPTION_ROW}>
                      {liveStep.ownerHandle ? (
                        <span className={chrome.OWNER_BADGE} data-testid={testId("landing-owner-badge")}>
                          {liveStep.ownerHandle}
                        </span>
                      ) : null}
                      <span className={chrome.CAPTION_TEXT} data-sweep-text={liveStep.caption} data-testid={testId("landing-run-caption")}>
                        {liveStep.caption}
                      </span>
                      {liveStep.kind === "command" ? (
                        <span className={chrome.STOP_GLYPH} data-testid={testId("landing-run-stop")}>
                          <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <Reveal visible={done} className="[grid-area:1/1]" testId={testId("landing-summary")}>
                  <div className={chrome.SUMMARY_SECTION}>
                    <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} notches={[{ offsetPx: 9, maskLine: true }]} />
                    <div className="min-w-0">
                      <div className={chrome.SUMMARY_STACK}>
                        <div className={chrome.MESSAGE_CONTENT}>
                          <p className={chrome.MESSAGE_PARAGRAPH}>{scenario.summary}</p>
                          {scenario.codeLines ? (
                            <pre className={`mt-2 ${chrome.CODE_BLOCK_CLASS}`} data-testid={testId("landing-code-block")}>
                              <code>{scenario.codeLines.join("\n")}</code>
                            </pre>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </Reveal>
              </div>

              {/* The file rail and, for code, the open diff card. */}
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
              {scenario.diffRows ? (
                <Reveal visible={artifactOpen}>
                  <DiffCard scenario={scenario} withTestIds={withTestIds} />
                </Reveal>
              ) : null}
              {/* The app docks the shared browser above the composer; in a card
                  read from the top the page belongs in the message that opened
                  it, in the slot the diff card takes, on the same artifact beat
                  and before Kim replies to it. */}
              {site ? <BrowserDock visible={artifactOpen} beat={beat} playing={playing} withTestIds={withTestIds} /> : null}

              {/* The closing stub sits at the foot of the body, which is already
                  the turn's final height, so like the bridging spine it waits
                  for the last section rather than hanging in empty space. */}
              <Reveal visible={threadComplete}>
                <div className={chrome.END_STUB}>
                  <ThreadSpine tone="primary" className={chrome.THREAD_SPINE_NOTCH} segments={[{ topPx: -1, heightPx: 6 }]} />
                </div>
              </Reveal>
            </div>
          </div>
        </ChatBubbleRow>

        {/* Row 4, slot C: Kim typing, then Kim's reply in the same cell. */}
        <div className="grid min-w-0">
          {showKimTyping ? (
            <div aria-hidden="true" className={`[grid-area:1/1] min-w-0 ${chrome.PEER_TYPING_ROW}`}>
              <CrewAvatar initial="K" color={KIM_COLOR} size="sm" />
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
          <Reveal visible={beat >= BEAT.REPLY} className="[grid-area:1/1]" testId={testId("landing-kim-reply")}>
            <ChatBubbleRow
              align="left"
              avatar={<CrewAvatar initial="K" color={KIM_COLOR} size="sm" />}
              speakerIdentity={<SpeakerLabel name="Kim" time="now" />}
              speakerMarker={null}
            >
              <TeammateMessage text={scenario.reply} />
            </ChatBubbleRow>
          </Reveal>
        </div>
      </ChatColumn>
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
export function MiniComposer({ prompt, beat, playing }: { prompt: string; beat: number; playing: boolean }) {
  const typing = playing && beat === BEAT.TYPING;
  const held = playing && beat === BEAT.SEND;
  const draft = typing || held;
  return (
    <div aria-hidden="true" className={chrome.COMPOSER_WRAP}>
      <div className={CHAT_COLUMN_CLASS_NAME}>
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
