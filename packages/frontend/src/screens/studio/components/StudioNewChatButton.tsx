import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { DialogTrigger } from "react-aria-components";
import { ChatLines, Lock, NavArrowRight, Plus } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { EntityRow } from "../../../components/EntityRow";
import { SearchInput } from "../../../components/SearchInput";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useProjects } from "../../../projects/useProjects";
import { useAuth } from "../../../providers/AuthProvider";
import { controllerClient, type ControllerProjectMember } from "../../../sdk/instafy";
import { DARK_RAIL_HOVER_CLASS } from "../../../theme/darkSurfaces";
import { useWorkspaceControls } from "../workspaceControls";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";

const { listMembers: listControllerOrgMembers } = controllerClient.organizations;
const { listMembers: listControllerProjectMembers } = controllerClient.projects;

function resolvePrivateChatDisplayName(member: ControllerProjectMember): string {
  const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
  if (fullName) {
    return fullName;
  }
  const email = typeof member.email === "string" ? member.email.trim() : "";
  if (email) {
    return email;
  }
  return "Teammate";
}

function resolvePrivateChatSubtitle(member: ControllerProjectMember): string | null {
  const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
  const email = typeof member.email === "string" ? member.email.trim() : "";
  if (fullName && email) {
    return email;
  }
  return null;
}

type StudioNewChatButtonProps = {
  testId?: string;
  className?: string;
  size?: ComponentProps<typeof IconButton>["size"];
  radius?: ComponentProps<typeof IconButton>["radius"];
  onStarted?: () => void;
  /** Run creation after a navigation owner dismisses its drawer. */
  runAction?: (action: () => void) => void;
  label?: string;
  isDisabled?: boolean;
  dismissalKey?: string;
  renderTrigger?: (actions: {
    onNewChat?: () => void;
    onNewPrivateChat?: () => void;
  }) => ReactNode;
};

/** Shared public/private chat creation for the tab bar and recent-chat navigation. */
export function StudioNewChatButton({
  testId = "topbar-new-conversation",
  className = `h-10 w-10 rounded-full border border-transparent bg-transparent shadow-none focus-visible:ring-white/16 focus-visible:ring-offset-white dark:focus-visible:ring-white/16 dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)] [aria-expanded=true]:dark:bg-white/[0.05] ${DARK_RAIL_HOVER_CLASS}`,
  size = "md",
  radius = "full",
  onStarted,
  runAction,
  label,
  isDisabled = false,
  dismissalKey,
  renderTrigger,
}: StudioNewChatButtonProps) {
  const {
    onStartNewConversation,
    onStartPrivateConversation,
    showChatActions = false,
    onOpenProjectSettings,
  } = useWorkspaceControls();
  const { projectList, activeProjectId } = useProjects();
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const shouldShowNewChat = showChatActions && Boolean(onStartNewConversation);
  const searchId = useId();
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [privateChatPickerOpen, setPrivateChatPickerOpen] = useState(false);
  const [privateChatQuery, setPrivateChatQuery] = useState("");
  const [privateChatTargets, setPrivateChatTargets] = useState<ControllerProjectMember[]>([]);
  const [privateChatTargetsLoading, setPrivateChatTargetsLoading] = useState(false);
  const [privateChatTargetsLoaded, setPrivateChatTargetsLoaded] = useState(false);
  const privateChatTargetsRequestRef = useRef<Promise<ControllerProjectMember[]> | null>(null);
  const privateChatTargetsEpochRef = useRef(0);
  const newChatTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newChatInteractionModalityRef = useRef<"pointer" | "keyboard" | null>(null);
  const startConversation = (action: () => void) => {
    const start = () => { action(); onStarted?.(); };
    if (runAction) runAction(start);
    else start();
  };

  useNativeBackButtonAction(privateChatPickerOpen || newChatMenuOpen, () => {
    setPrivateChatPickerOpen(false);
    setPrivateChatQuery("");
    setNewChatMenuOpen(false);
  });

  useEffect(() => {
    // The custom trigger can live inside More while this dialog owner remains
    // mounted. Its secondary surfaces still belong to one exact visit.
    setPrivateChatPickerOpen(false);
    setPrivateChatQuery("");
    setNewChatMenuOpen(false);
  }, [dismissalKey]);

  useEffect(() => {
    privateChatTargetsEpochRef.current += 1;
    privateChatTargetsRequestRef.current = null;
    setNewChatMenuOpen(false);
    setPrivateChatPickerOpen(false);
    setPrivateChatQuery("");
    setPrivateChatTargets([]);
    setPrivateChatTargetsLoading(false);
    setPrivateChatTargetsLoaded(false);
  }, [activeProjectId, currentUserId]);

  const loadPrivateChatTargets = useCallback(async (): Promise<ControllerProjectMember[]> => {
    if (privateChatTargetsLoaded) {
      return privateChatTargets;
    }
    if (privateChatTargetsRequestRef.current) {
      return privateChatTargetsRequestRef.current;
    }

    const epoch = privateChatTargetsEpochRef.current;
    const inflight = (async (): Promise<ControllerProjectMember[]> => {
      if (!activeProjectId) {
        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargets([]);
          setPrivateChatTargetsLoaded(true);
          setPrivateChatTargetsLoading(false);
        }
        return [];
      }

      if (epoch === privateChatTargetsEpochRef.current) {
        setPrivateChatTargetsLoading(true);
      }

      try {
        const project = projectList.find((entry) => entry.id === activeProjectId) ?? null;
        const orgId = project?.orgId ?? null;
        const [orgMembers, projectMembers] = await Promise.all([
          orgId ? listControllerOrgMembers(orgId) : Promise.resolve([]),
          listControllerProjectMembers(activeProjectId),
        ]);
        const members = orgId ? [...orgMembers, ...projectMembers] : projectMembers;

        const filtered: ControllerProjectMember[] = [];
        const seenUserIds = new Set<string>();
        for (const member of members) {
          const userId = typeof member.userId === "string" ? member.userId.trim() : "";
          if (!userId || userId === currentUserId) {
            continue;
          }
          if (seenUserIds.has(userId)) {
            continue;
          }
          seenUserIds.add(userId);
          filtered.push(member);
        }
        filtered.sort((a, b) => {
          const labelA = `${a.fullName ?? ""} ${a.email ?? ""}`.trim().toLowerCase();
          const labelB = `${b.fullName ?? ""} ${b.email ?? ""}`.trim().toLowerCase();
          return labelA.localeCompare(labelB);
        });

        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargets(filtered);
          setPrivateChatTargetsLoaded(true);
        }
        return filtered;
      } catch {
        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargets([]);
          setPrivateChatTargetsLoaded(true);
        }
        return [];
      } finally {
        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargetsLoading(false);
        }
      }
    })();

    privateChatTargetsRequestRef.current = inflight;
    try {
      return await inflight;
    } finally {
      if (privateChatTargetsRequestRef.current === inflight) {
        privateChatTargetsRequestRef.current = null;
      }
    }
  }, [
    activeProjectId,
    currentUserId,
    privateChatTargets,
    privateChatTargetsLoaded,
    projectList,
  ]);

  const filteredPrivateChatTargets = useMemo(() => {
    const query = privateChatQuery.trim().toLowerCase();
    if (!query) {
      return privateChatTargets;
    }
    return privateChatTargets.filter((member) => {
      const displayName = resolvePrivateChatDisplayName(member).toLowerCase();
      const email = (member.email ?? "").trim().toLowerCase();
      return displayName.includes(query) || email.includes(query);
    });
  }, [privateChatQuery, privateChatTargets]);

  const handleNewChatMenuOpenChange = useCallback(
    (open: boolean) => {
      setNewChatMenuOpen(open);
      if (!open && newChatInteractionModalityRef.current === "pointer") {
        requestAnimationFrame(() => {
          newChatTriggerRef.current?.blur();
        });
      }
      if (open && onStartPrivateConversation && !privateChatTargetsLoaded && !privateChatTargetsLoading) {
        void loadPrivateChatTargets();
      }
      if (!open) {
        newChatInteractionModalityRef.current = null;
      }
    },
    [
      loadPrivateChatTargets,
      onStartPrivateConversation,
      privateChatTargetsLoaded,
      privateChatTargetsLoading,
    ],
  );

  const newChatMenu = shouldShowNewChat ? (
    <StudioDialogPopover placement="bottom start" offset={8} className="w-80 max-w-[calc(100vw-1.5rem)] p-3" data-testid="chat-new-chat-menu-popover">
      <div className="flex flex-col gap-1.5">
        <EntityRow
          title="Public chat"
          surface="interactive"
          pressable
          start={<ChatLines className="h-4 w-4 text-slate-400 dark:text-slate-400" aria-hidden="true" />}
          onPress={() => {
            setNewChatMenuOpen(false);
            startConversation(() => onStartNewConversation?.());
          }}
          data-testid="chat-new-chat-public"
        />

        {onStartPrivateConversation ? (
          <EntityRow
            title="Private chat"
            surface="interactive"
            pressable
            start={<Lock className="h-4 w-4 text-slate-400 dark:text-slate-400" aria-hidden="true" />}
            end={<NavArrowRight className="h-4 w-4 text-slate-400 dark:text-slate-400" aria-hidden="true" />}
            onPress={() => {
              setNewChatMenuOpen(false);
              setPrivateChatPickerOpen(true);
              setPrivateChatQuery("");
              void loadPrivateChatTargets();
            }}
            data-testid="chat-new-chat-private"
          />
        ) : null}
      </div>
    </StudioDialogPopover>
  ) : null;

  if (!shouldShowNewChat && !renderTrigger) {
    return null;
  }

  return (
    <>
      {renderTrigger ? renderTrigger({
        onNewChat: shouldShowNewChat ? () => {
          setNewChatMenuOpen(false);
          startConversation(() => onStartNewConversation?.());
        } : undefined,
        onNewPrivateChat: shouldShowNewChat && onStartPrivateConversation ? () => {
          setNewChatMenuOpen(false);
          setPrivateChatPickerOpen(true);
          setPrivateChatQuery("");
          void loadPrivateChatTargets();
        } : undefined,
      }) : <DialogTrigger isOpen={newChatMenuOpen} onOpenChange={handleNewChatMenuOpenChange}>
        <IconButton
          ref={newChatTriggerRef}
          type="button"
          variant="ghost"
          size={size}
          radius={radius}
          isDisabled={isDisabled}
          aria-label="New chat"
          title="New chat"
          data-testid={testId}
          className={className}
          onPointerDown={() => {
            newChatInteractionModalityRef.current = "pointer";
          }}
          onKeyDown={() => {
            newChatInteractionModalityRef.current = "keyboard";
          }}
        >
          <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
          {label ? <span className="truncate">{label}</span> : null}
        </IconButton>
        {newChatMenu}
      </DialogTrigger>}
      <StudioDialogModal
        isOpen={privateChatPickerOpen}
        onOpenChange={(open) => {
          setPrivateChatPickerOpen(open);
          if (!open) {
            setPrivateChatQuery("");
          }
        }}
        isDismissable
        dialogAriaLabel="Start private chat"
        data-testid="chat-private-chat-modal"
        modalClassName="max-h-[min(90dvh,42rem)] max-w-xl overflow-hidden p-0"
      >
        <div className="flex max-h-[min(90dvh,42rem)] flex-col">
          <StudioDialogHeader
            title="Private chat"
            description="Choose one teammate to start a private conversation."
            descriptionClassName="mt-1 text-sm"
            onClose={() => {
              setPrivateChatPickerOpen(false);
              setPrivateChatQuery("");
            }}
            closeLabel="Close private chat picker"
            className="px-4 py-3"
          />

          <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3">
            <SearchInput
              id={searchId}
              label="Search teammates"
              value={privateChatQuery}
              onChange={(event) => setPrivateChatQuery(event.target.value)}
              placeholder="Search teammates…"
              autoFocus
              data-testid="chat-private-chat-search"
            />

            {privateChatTargetsLoading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300">
                <Spinner aria-hidden="true" size="xs" />
                Loading teammates…
              </div>
            ) : privateChatTargets.length === 0 ? (
              <div className="mt-4 space-y-3">
                <Text as="p" variant="caption" tone="muted" className="text-sm leading-relaxed">
                  Invite a teammate to unlock private chats in this space.
                </Text>
                {onOpenProjectSettings ? (
                  <Button
                    variant="outline"
                    size="sm"
                    radius="full"
                    onPress={() => {
                      setPrivateChatPickerOpen(false);
                      setPrivateChatQuery("");
                      onOpenProjectSettings();
                    }}
                  >
                    Invite teammate
                  </Button>
                ) : null}
              </div>
            ) : filteredPrivateChatTargets.length === 0 ? (
              <div className="mt-4 space-y-3">
                <Text as="p" variant="caption" tone="muted" className="text-sm leading-relaxed">
                  No teammates match that search.
                </Text>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="full"
                  className="justify-start"
                  onPress={() => setPrivateChatQuery("")}
                >
                  Clear search
                </Button>
              </div>
            ) : (
              <div className="mt-4 space-y-2" data-testid="chat-private-chat-list">
                {filteredPrivateChatTargets.map((member) => {
                  const userId = typeof member.userId === "string" ? member.userId.trim() : "";
                  if (!userId) {
                    return null;
                  }
                  const displayName = resolvePrivateChatDisplayName(member);
                  return (
                    <EntityRow
                      key={userId}
                      title={displayName}
                      subtitle={resolvePrivateChatSubtitle(member) ?? undefined}
                      surface="interactive"
                      pressable
                      onPress={() => {
                        setPrivateChatPickerOpen(false);
                        setPrivateChatQuery("");
                        startConversation(() => onStartPrivateConversation?.({ userId, displayName }));
                      }}
                      data-testid={`chat-private-chat-target-${userId}`}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </StudioDialogModal>
    </>
  );
}
