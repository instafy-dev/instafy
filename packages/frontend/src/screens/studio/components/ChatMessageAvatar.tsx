import { useMemo } from "react";
import { OctoCoin } from "../../../components/OctoCoin";
import { HumanAvatar } from "../../../components/HumanAvatar";
import {
  OCTO_AVATAR_SRC,
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import type { AssistantAvatarMotion } from "./chatAssistantIdentity";

export type ChatMessageAvatarKind = "assistant" | "human";

type AgentAvatarIdentity = { handle: string; avatarSeed: string };

type ChatMessageAgentAvatarOverride = {
  handle?: string | null;
  avatarSeed?: string | null;
};

function extractAgentAvatarIdentity(metadata: unknown): AgentAvatarIdentity | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const agent = (metadata as Record<string, unknown>).agent;
  if (!agent || typeof agent !== "object") {
    return null;
  }
  const handleRaw = (agent as Record<string, unknown>).handle;
  const handleValue = typeof handleRaw === "string" ? handleRaw.trim() : "";
  const normalizedHandle = handleValue.startsWith("@") ? handleValue.slice(1).trim().toLowerCase() : handleValue.toLowerCase();
  if (!normalizedHandle) {
    return null;
  }
  const avatarSeedRaw = (agent as Record<string, unknown>).avatarSeed;
  const avatarSeed =
    typeof avatarSeedRaw === "string" && avatarSeedRaw.trim().length > 0 ? avatarSeedRaw.trim() : normalizedHandle;
  return { handle: normalizedHandle, avatarSeed };
}

function extractAgentAvatarIdentityFromOverride(
  override: ChatMessageAgentAvatarOverride | null | undefined,
): AgentAvatarIdentity | null {
  if (!override || typeof override !== "object") {
    return null;
  }
  const handleRaw = typeof override.handle === "string" ? override.handle.trim() : "";
  const handleValue = handleRaw.startsWith("@") ? handleRaw.slice(1).trim() : handleRaw;
  const normalizedHandle = handleValue.toLowerCase();
  if (!normalizedHandle) {
    return null;
  }
  const avatarSeedRaw = typeof override.avatarSeed === "string" ? override.avatarSeed.trim() : "";
  const avatarSeed = avatarSeedRaw || normalizedHandle;
  return { handle: normalizedHandle, avatarSeed };
}

export function ChatMessageAvatar({
  kind,
  metadata,
  agent,
  label,
  avatarUrl,
  motion = "idle",
  scrollReactive = false,
  seed,
  size = "sm",
  testId: testIdOverride,
}: {
  kind: ChatMessageAvatarKind;
  metadata?: unknown;
  agent?: ChatMessageAgentAvatarOverride | null;
  label?: string | null;
  avatarUrl?: string | null;
  motion?: AssistantAvatarMotion;
  scrollReactive?: boolean;
  seed?: string | null;
  size?: "2xs" | "xs" | "sm" | "lg";
  /**
   * A second face of the same speaker on one row (the phone-only thinking
   * indicator beside the gutter avatar) needs its own selector, or the
   * gutter's chat-avatar-* selector would match both.
   */
  testId?: string;
}) {
  const agentIdentity =
    kind === "assistant"
      ? extractAgentAvatarIdentityFromOverride(agent) ?? extractAgentAvatarIdentity(metadata)
      : null;
  const assistantAvatarImageSrc =
    kind === "assistant"
      ? resolveAgentAvatarImageSrc({
          handle: agentIdentity?.handle ?? "octo",
          avatarSeed: agentIdentity?.avatarSeed ?? null,
        })
      : null;
  const usesAssistantImageAvatar = kind === "assistant" && Boolean(assistantAvatarImageSrc);
  const usesCanonicalOctoAvatar =
    kind === "assistant" && assistantAvatarImageSrc === OCTO_AVATAR_SRC;
  const testId =
    testIdOverride ?? (kind === "assistant" ? "chat-avatar-assistant" : "chat-avatar-human");
  // Light: no border, only the avatar coin shadow (below). Dark keeps its
  // hairline border and small shadow.
  const wrapperClass = usesAssistantImageAvatar
    ? "bg-white dark:border-slate-700 dark:bg-slate-900"
    : "text-white dark:border-slate-800";

  const gradientStyle = useMemo(() => {
    if (kind !== "assistant" || usesAssistantImageAvatar || !agentIdentity) {
      return undefined;
    }
    return { backgroundImage: resolveAgentAvatarGradient(agentIdentity.avatarSeed) };
  }, [agentIdentity, kind, usesAssistantImageAvatar]);

  // "2xs" exists for ambient presence surfaces (the top-bar conversation
  // roster), where a transcript-sized face reads far too loud.
  const sizeClassName =
    size === "lg"
      ? "h-12 w-12"
      : size === "2xs"
        ? "h-6 w-6"
        : size === "xs"
          ? "h-7 w-7"
          : "h-8 w-8";
  const textClassName = size === "lg" ? "text-sm" : size === "2xs" ? "text-xxs" : "text-xs";

  if (kind === "human") {
    // HumanAvatar draws the shared avatar coin shadow in light; dark keeps
    // the small shadow these faces always had.
    return <HumanAvatar userId={seed} displayName={label} avatarUrl={avatarUrl}
      data-testid={testId} className={`${sizeClassName} ${textClassName} dark:shadow-sm`} />;
  }

  // Octo is its coin (OctoCoin, docs/Brand.md): the coin draws its own edge
  // (the shared avatar coin shadow in light, its faint ring in dark), so it
  // takes none of the shell's dark border or shadow below.
  if (usesCanonicalOctoAvatar) {
    return (
      <OctoCoin
        testId={testId}
        className={sizeClassName}
        motion={motion}
        scrollReactive={scrollReactive}
      />
    );
  }

  return (
    <div
      data-testid={testId}
      aria-hidden="true"
      className={`flex ${sizeClassName} shrink-0 items-center justify-center overflow-hidden rounded-full shadow-avatar-coin dark:border dark:shadow-sm ${wrapperClass}`}
      style={gradientStyle}
    >
      {usesAssistantImageAvatar && assistantAvatarImageSrc ? (
        <img
          src={assistantAvatarImageSrc}
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          draggable={false}
        />
      ) : (
        <span className={`${textClassName} font-semibold`}>
          {resolveAgentAvatarText({ handle: agentIdentity?.handle ?? "agent" })}
        </span>
      )}
    </div>
  );
}
