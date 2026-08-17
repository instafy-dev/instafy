import type { ReactNode } from "react";
import { Heading } from "../../components/Heading";
import { Text } from "../../components/Text";

const CARD_CLASS =
  "flex flex-col gap-2.5 rounded-3xl border border-slate-200 bg-white/70 p-6 shadow-[0_18px_45px_rgba(15,23,42,0.08)] backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-[0_18px_45px_rgba(0,0,0,0.35)]";

// No icon tiles: each card is marked by the hero's presence-cursor glyph in
// its crew color, inline with the title, so the section speaks the page's own
// visual language instead of a component library's.
function CursorGlyph({ color }: { color: string }) {
  return (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 18 20">
      <path d="M2 1 L16 10 L9 11.5 L7 19 Z" fill={color} stroke="#ffffff" strokeWidth="1.5" />
    </svg>
  );
}

function Feature(props: { accent: string; title: string; children: ReactNode }) {
  return (
    <div className={CARD_CLASS}>
      <div className="flex items-center gap-2.5">
        <CursorGlyph color={props.accent} />
        <Heading level={3} variant="display" className="text-slate-900 dark:text-white">
          {props.title}
        </Heading>
      </div>
      <Text variant="body" tone="secondary">
        {props.children}
      </Text>
    </div>
  );
}

export function LandingFeatures() {
  return (
    <div className="w-full">
      <div className="mx-auto max-w-2xl text-center">
        <Text variant="caption" tone="muted" className="uppercase tracking-[0.18em]">
          How it works
        </Text>
        <Heading level={2} variant="section" className="mt-3 text-slate-900 dark:text-white">
          One session, the whole crew.
        </Heading>
        <Text variant="lead" tone="secondary" className="mx-auto mt-4 max-w-xl">
          Invite people and agents into the same live session. Everyone sees the same files, the
          same preview, and every change that lands.
        </Text>
      </div>

      <div className="mt-12 grid w-full grid-cols-1 gap-6 sm:grid-cols-2">
        <Feature accent="#e93d82" title="Real seats for people and agents">
          Invite your cofounder as owner and your accountant as editor, and give each agent its
          own seat. Roles decide who can change what.
        </Feature>

        <Feature accent="#f5960a" title="Bring the AI you already pay for">
          Connect a ChatGPT or Codex plan, an API key, or DeepSeek, z.ai, and Gemini. Your
          provider handles billing, and nothing locks you in.
        </Feature>

        <Feature accent="#7c4dd8" title="Every change is a real commit">
          Agents edit real files in a git repo you own. Review diffs, revert in a click, and keep
          an audit trail that works for code and books alike.
        </Feature>

        <Feature accent="#8cb93b" title="The studio runs anywhere">
          Open a session from your laptop or phone, no install. The built-in shared browser lets
          the whole crew click through the same preview together.
        </Feature>
      </div>
    </div>
  );
}
