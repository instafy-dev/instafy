import { useBreakpoint } from "../../hooks/useBreakpoint";
import { useTouchLikeInput } from "../../hooks/useTouchLikeInput";
import { useStudioDesktopLayout } from "./useStudioDesktopLayout";

export function useStudioNavigationPosture() {
  const isLargeScreen = useStudioDesktopLayout();
  const isAtLeastMediumViewport = useBreakpoint("md");
  const touchLikeInput = useTouchLikeInput();

  const showComposerHomeButton = touchLikeInput && !isLargeScreen && !isAtLeastMediumViewport;
  const showTopbarHomeButton = !isLargeScreen && !showComposerHomeButton;
  const showTouchBottomDock = touchLikeInput && !isLargeScreen;

  return {
    isLargeScreen,
    touchLikeInput,
    showComposerHomeButton,
    showTouchBottomDock,
    showTopbarHomeButton,
  };
}
