import { DotsGrid3x3, NavArrowLeft, Page, Plus, ChatLines } from "iconoir-react";

import { HomeIcon } from "../../../components/AppIcons";
import { Button } from "../../../components/Button";

type MobileBottomDockActiveSlot = "home" | "chat" | "files" | "projects" | null;

interface MobileBottomDockProps {
  primaryMode: "home" | "return";
  activeSlot: MobileBottomDockActiveSlot;
  homeAttentionCount: number;
  onPrimaryPress: () => void;
  onChatPress: () => void;
  onNewChatPress: () => void;
  onFilesPress: () => void;
  onProjectsPress: () => void;
}

function dockButtonClass(active: boolean): string {
  return [
    "relative h-12 min-w-0 flex-1 basis-0 px-0 transition focus-visible:ring-offset-0",
    active
      ? "bg-slate-900 text-white hover:bg-slate-900 dark:bg-white dark:text-slate-950 dark:hover:bg-white"
      : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-900/80 dark:hover:text-slate-50",
  ].join(" ");
}

export function MobileBottomDock({
  primaryMode,
  activeSlot,
  homeAttentionCount,
  onPrimaryPress,
  onChatPress,
  onNewChatPress,
  onFilesPress,
  onProjectsPress,
}: MobileBottomDockProps) {
  const homeAttentionBadge = homeAttentionCount > 9 ? "9+" : homeAttentionCount.toString();
  const primaryTestId = primaryMode === "return" ? "mobile-bottom-dock-return" : "mobile-bottom-dock-home";

  return (
    <div
      data-testid="mobile-bottom-dock"
      className="w-full shrink-0 border-t border-slate-200/70 bg-white/95 px-3 pt-2 shadow-[0_-8px_24px_-20px_rgba(15,23,42,0.28)] backdrop-blur-md max-[375px]:px-2 max-[375px]:pt-1 dark:border-slate-800/90 dark:bg-slate-950/95 dark:shadow-none"
      style={{ paddingBottom: "max(var(--instafy-safe-area-inset-bottom), 0.5rem)" }}
    >
      <div className="flex w-full items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          radius="2xl"
          fullWidth
          aria-label={primaryMode === "return" ? "Return to previous surface" : "Open home"}
          data-testid={primaryTestId}
          className={dockButtonClass(primaryMode === "home" && activeSlot === "home")}
          onPress={onPrimaryPress}
        >
          <span className="flex h-full w-full items-center justify-center">
            <span className="relative flex h-6 w-6 items-center justify-center overflow-visible">
              {primaryMode === "return" ? (
                <NavArrowLeft className="h-[22px] w-[22px]" aria-hidden="true" />
              ) : (
                <HomeIcon className="h-[22px] w-[22px]" aria-hidden="true" />
              )}
              {primaryMode === "home" && homeAttentionCount > 0 ? (
                <span
                  aria-hidden="true"
                  data-testid="mobile-bottom-dock-home-badge"
                  className="absolute -right-2 -top-2 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white dark:bg-primary-500 dark:ring-slate-950"
                >
                  {homeAttentionBadge}
                </span>
              ) : null}
            </span>
          </span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          radius="2xl"
          fullWidth
          aria-label="Open chat"
          data-testid="mobile-bottom-dock-chat"
          className={dockButtonClass(activeSlot === "chat")}
          onPress={onChatPress}
        >
          <span className="flex h-full w-full items-center justify-center">
            <ChatLines className="h-[22px] w-[22px]" aria-hidden="true" />
          </span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          radius="2xl"
          fullWidth
          aria-label="Start new chat"
          data-testid="mobile-bottom-dock-new-chat"
          className={dockButtonClass(false)}
          onPress={onNewChatPress}
        >
          <span className="flex h-full w-full items-center justify-center">
            <Plus className="h-[22px] w-[22px]" aria-hidden="true" />
          </span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          radius="2xl"
          fullWidth
          aria-label="Open files"
          data-testid="mobile-bottom-dock-files"
          className={dockButtonClass(activeSlot === "files")}
          onPress={onFilesPress}
        >
          <span className="flex h-full w-full items-center justify-center">
            <Page className="h-[22px] w-[22px]" aria-hidden="true" />
          </span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          radius="2xl"
          fullWidth
          aria-label="Switch space"
          data-testid="mobile-bottom-dock-projects"
          className={dockButtonClass(activeSlot === "projects")}
          onPress={onProjectsPress}
        >
          <span className="flex h-full w-full items-center justify-center">
            <DotsGrid3x3 className="h-[22px] w-[22px]" aria-hidden="true" />
          </span>
        </Button>
      </div>
    </div>
  );
}
