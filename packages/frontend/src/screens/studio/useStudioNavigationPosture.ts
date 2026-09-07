import { useTouchLikeInput } from "../../hooks/useTouchLikeInput";
import { useStudioDesktopLayout } from "./useStudioDesktopLayout";

export function useStudioNavigationPosture() {
  const isLargeScreen = useStudioDesktopLayout();
  const touchLikeInput = useTouchLikeInput();

  const showComposerNavigationButton = !isLargeScreen;
  const showTouchBottomDock = touchLikeInput && !isLargeScreen;

  return {
    isLargeScreen,
    touchLikeInput,
    showComposerNavigationButton,
    showTouchBottomDock,
  };
}
