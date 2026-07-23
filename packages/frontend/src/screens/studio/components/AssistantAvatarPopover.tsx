import { Settings } from "iconoir-react";
import { DialogTrigger } from "react-aria-components";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import type { AssistantAvatarMotion } from "./chatAssistantIdentity";

export function AssistantAvatarPopover({
  agentAvatarSeed,
  agentHandle,
  displayName,
  metadata,
  motion = "idle",
  scrollReactive = false,
  onOpenSettings,
  pinnedRuntimeId,
  resourcesSummary,
  runtimeLabel,
  runtimeState,
}: {
  agentAvatarSeed: string;
  agentHandle: string;
  displayName: string;
  metadata?: Record<string, unknown> | null;
  motion?: AssistantAvatarMotion;
  scrollReactive?: boolean;
  onOpenSettings: (handle: string) => void;
  pinnedRuntimeId: string | null;
  resourcesSummary: string | null;
  runtimeLabel: string;
  runtimeState: string;
}) {
  return (
    <DialogTrigger>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        radius="full"
        aria-label={`Agent info: ${displayName}`}
        className="relative z-10 h-8 w-8 bg-transparent p-0 shadow-none hover:bg-transparent data-[hovered]:bg-transparent"
      >
        <ChatMessageAvatar
          kind="assistant"
          metadata={metadata ?? null}
          agent={{ handle: agentHandle, avatarSeed: agentAvatarSeed }}
          motion={motion}
          scrollReactive={scrollReactive}
        />
      </Button>
      <StudioDialogPopover placement="top" offset={8} className="w-80 overflow-hidden p-0">
        <div className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <ChatMessageAvatar
              kind="assistant"
              metadata={metadata ?? null}
              agent={{ handle: agentHandle, avatarSeed: agentAvatarSeed }}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Text as="div" variant="bodyStrong" tone="inherit" className="truncate text-sm">
                    {displayName}
                  </Text>
                  <Text as="div" variant="caption" tone="muted" className="truncate text-xs">
                    @{agentHandle}
                  </Text>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {pinnedRuntimeId ? (
                    <Badge size="xs" className="shrink-0 text-slate-600">
                      Pinned
                    </Badge>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    radius="full"
                    onPress={() => onOpenSettings(agentHandle)}
                    className="gap-1.5 px-2.5 text-slate-600 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10 dark:data-[hovered]:bg-white/10"
                  >
                    <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                    Settings
                  </Button>
                </div>
              </div>
              <Text as="div" variant="caption" tone="secondary" className="mt-1 text-xs leading-5">
                {pinnedRuntimeId
                  ? "Replies with the runtime pinned to this agent."
                  : "Replies with the best available runtime in this space."}
              </Text>
            </div>
          </div>
          <Surface tone="muted" radius="xl" shadow="none" className="space-y-1.5 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <Text as="div" variant="label" tone="subtle">
                Runtime
              </Text>
              <Text as="div" variant="caption" tone="secondary" className="shrink-0 text-xs capitalize">
                {runtimeState}
              </Text>
            </div>
            <Text as="div" variant="bodyStrong" tone="primary" className="truncate text-sm">
              {runtimeLabel}
            </Text>
            {resourcesSummary ? (
              <Text as="div" variant="caption" tone="muted" className="text-xs leading-5">
                {resourcesSummary}
              </Text>
            ) : null}
          </Surface>
        </div>
      </StudioDialogPopover>
    </DialogTrigger>
  );
}
