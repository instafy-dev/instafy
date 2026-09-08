import { DotsGrid3x3, ChatLines } from "iconoir-react";
import type { ReactNode } from "react";
import type { MobileOverviewSection } from "../useStudioNavigationPosture";

import { HomeIcon } from "../../../components/AppIcons";
import { Button } from "../../../components/Button";

interface MobileBottomDockProps {
  activeSlot: MobileOverviewSection;
  homeAttentionCount: number;
  onHomePress: () => void;
  onChatPress: () => void;
  onProjectsPress: () => void;
}

/** Stable section destinations on overview screens, never history actions or
 * an extra row beneath a conversation's composer. */
export function MobileBottomDock({
  activeSlot,
  homeAttentionCount,
  onHomePress,
  onChatPress,
  onProjectsPress,
}: MobileBottomDockProps) {
  const items: Array<{
    id: string; label: string; ariaLabel: string; icon: ReactNode;
    active?: boolean; onPress: () => void;
  }> = [
    { id: "home", label: "Home", ariaLabel: "Open home", icon: <HomeIcon />, active: activeSlot === "home", onPress: onHomePress },
    { id: "chat", label: "Chats", ariaLabel: "Open chats", icon: <ChatLines />, active: activeSlot === "chat", onPress: onChatPress },
    { id: "projects", label: "Spaces", ariaLabel: "Open spaces", icon: <DotsGrid3x3 />, active: activeSlot === "projects", onPress: onProjectsPress },
  ];

  return (
    <nav
      aria-label="Studio navigation"
      data-testid="mobile-bottom-dock"
      className="w-full shrink-0 border-t border-slate-200/70 bg-white/95 px-3 pt-1 backdrop-blur-md max-[375px]:px-2 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]"
      style={{ paddingBottom: "max(var(--instafy-safe-area-inset-bottom), 0.25rem)" }}
    >
      <div className="flex w-full items-center gap-1">
        {items.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            radius="xl"
            aria-label={item.ariaLabel}
            aria-current={item.active ? "page" : undefined}
            data-testid={`mobile-bottom-dock-${item.id}`}
            className={[
              "relative h-12 min-h-12 min-w-12 flex-1 basis-0 flex-col gap-0.5 px-0 focus-visible:ring-offset-0",
              item.active
                ? "bg-slate-100 text-slate-950 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-50"
                : "text-slate-500 dark:text-slate-400",
            ].join(" ")}
            onPress={item.onPress}
          >
            <span className="relative flex h-5 w-5 items-center justify-center [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
              {item.icon}
              {item.id === "home" && homeAttentionCount > 0 ? (
                <span
                  data-testid="mobile-bottom-dock-home-badge"
                  className="absolute -right-2.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white dark:bg-primary-500"
                >
                  {homeAttentionCount > 9 ? "9+" : homeAttentionCount}
                </span>
              ) : null}
            </span>
            <span className="text-3xs leading-3">{item.label}</span>
          </Button>
        ))}
      </div>
    </nav>
  );
}
