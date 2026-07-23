import type { ReactNode } from "react";
import { Heading } from "../../components/Heading";
import { Text } from "../../components/Text";

const CARD_CLASS =
  "flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white/70 p-7 shadow-[0_18px_45px_rgba(15,23,42,0.08)] backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-[0_18px_45px_rgba(0,0,0,0.35)]";

const ICON_WRAP =
  "inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-500/10 text-slate-900 ring-1 ring-slate-200 dark:text-slate-100 dark:ring-slate-800";

function Feature(props: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={CARD_CLASS}>
      <span aria-hidden="true" className={ICON_WRAP}>
        {props.icon}
      </span>
      <Heading level={3} variant="display" className="text-slate-900 dark:text-white">
        {props.title}
      </Heading>
      <Text variant="body" tone="secondary">
        {props.children}
      </Text>
    </div>
  );
}

const iconProps = {
  className: "h-5 w-5",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

export function LandingFeatures() {
  return (
    <div className="w-full">
      <div className="mx-auto max-w-2xl text-center">
        <Text variant="caption" tone="muted" className="uppercase tracking-[0.18em]">
          How it works
        </Text>
        <Heading level={2} variant="section" className="mt-3 text-slate-900 dark:text-white">
          Your agent, in a repo you own.
        </Heading>
        <Text variant="lead" tone="secondary" className="mx-auto mt-4 max-w-xl">
          Bring the AI you already pay for. Every change lands as a real, reversible commit,
          whether you work on your machine or in a hosted workspace you can open from anywhere.
        </Text>
      </div>

      <div className="mt-12 grid w-full grid-cols-1 gap-6 md:grid-cols-3">
        <Feature
          title="Bring your own AI"
          icon={
            <svg {...iconProps}>
              <path d="M13 2 4.5 13.5H12l-1 8.5 8.5-11.5H12l1-8.5Z" />
            </svg>
          }
        >
          Connect a ChatGPT or Codex plan, use an OpenAI API key, or choose DeepSeek, z.ai, or
          Gemini. Instafy drives your model while your provider handles usage and billing. No
          lock-in.
        </Feature>

        <Feature
          title="Every change is a real commit"
          icon={
            <svg {...iconProps}>
              <circle cx="6" cy="6" r="2.5" />
              <circle cx="6" cy="18" r="2.5" />
              <circle cx="18" cy="16" r="2.5" />
              <path d="M6 8.5v7M8.4 6.4h4.6a3 3 0 0 1 3 3v4.1" />
            </svg>
          }
        >
          The agent edits real files in a real git repo. Review each change as a diff, revert any
          of it in one click, and clone it anywhere. Nothing is trapped in a chat log.
        </Feature>

        <Feature
          title="Local or hosted, on any device"
          icon={
            <svg {...iconProps}>
              <rect x="2.5" y="4.5" width="14" height="10" rx="1.5" />
              <path d="M2.5 18h14" />
              <rect x="17.5" y="9.5" width="4.5" height="9" rx="1.2" />
            </svg>
          }
        >
          Point it at a folder on your machine, or spin up a hosted workspace. Then open either from
          your laptop, browser, or phone.
        </Feature>
      </div>
    </div>
  );
}
