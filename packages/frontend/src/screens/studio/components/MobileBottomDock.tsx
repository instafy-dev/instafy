import { DotsGrid3x3, ChatLines } from "iconoir-react";
import type { ReactNode } from "react";
import type { MobileOverviewSection } from "../useStudioNavigationPosture";

import { HomeIcon } from "../../../components/AppIcons";
import { Button } from "../../../components/Button";
import "./MobileBottomDock.css";

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
      className="mobile-bottom-dock w-full shrink-0 border-t border-slate-200/70 bg-white/95 px-3 pt-1 backdrop-blur-md max-[375px]:px-2 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]"
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
              "mobile-bottom-dock-button relative h-12 min-h-12 min-w-12 flex-1 basis-0 px-0",
              item.active
                ? "aria-[current=page]:text-primary-700 dark:aria-[current=page]:text-primary-300"
                : "text-slate-500 dark:text-slate-400",
            ].join(" ")}
            onPress={item.onPress}
          >
            <span
              className="mobile-bottom-dock-content flex h-11 min-w-16 flex-col items-center justify-center gap-0.5 rounded-2xl px-2"
              data-testid={item.active ? "mobile-bottom-dock-active-indicator" : undefined}
            >
              <span
                className="relative flex h-5 w-5 items-center justify-center [&>svg]:h-5 [&>svg]:w-5"
                aria-hidden="true"
              >
                {item.icon}
                {item.id === "home" && homeAttentionCount > 0 ? (
                  <span
                    data-testid="mobile-bottom-dock-home-badge"
                    className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white dark:bg-primary-500"
                  >
                    {homeAttentionCount > 9 ? "9+" : homeAttentionCount}
                  </span>
                ) : null}
              </span>
              <span className={`text-3xs leading-3 ${item.active ? "font-semibold" : "font-normal"}`}>{item.label}</span>
            </span>
          </Button>
        ))}
      </div>
    </nav>
  );
}
