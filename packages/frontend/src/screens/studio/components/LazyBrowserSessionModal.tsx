import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { Button } from "../../../components/Button";
import { LoadingStatus } from "../../../components/LoadingStatus";
import type { BrowserSessionModal } from "./BrowserSessionModal";

type BrowserSessionModalProps = ComponentProps<typeof BrowserSessionModal>;

class BrowserCodeErrorBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function BrowserCodeFallback({
  browserProps,
  retry,
}: {
  browserProps: BrowserSessionModalProps;
  retry?: () => void;
}) {
  if (!browserProps.isOpen) return null;

  const content = (
    <section
      aria-label="Shared browser"
      className="flex min-h-40 flex-1 flex-col bg-white dark:bg-slate-950"
      data-browser-session-safe-zone="true"
      data-testid={retry ? "browser-session-code-error" : "browser-session-code-loading"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-2 dark:border-slate-800">
        {browserProps.toolbarLeading}
        <div className="ml-auto flex items-center gap-2">
          {browserProps.onBackToChat ? (
            <Button variant="ghost" size="sm" onPress={browserProps.onBackToChat}>Back to chat</Button>
          ) : null}
          <Button variant="ghost" size="sm" onPress={() => browserProps.onOpenChange(false)}>Close</Button>
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        {retry ? (
          <>
            <p role="alert" className="text-sm text-slate-600 dark:text-slate-400">
              Couldn’t load the shared browser. Check your connection and try again.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" onPress={retry}>Retry</Button>
              <Button variant="ghost" size="sm" onPress={() => window.location.reload()}>Reload app</Button>
            </div>
          </>
        ) : <LoadingStatus>Loading shared browser…</LoadingStatus>}
      </div>
    </section>
  );

  return browserProps.presentation === "docked" ? content : (
    <StudioDialogModal
      isOpen={browserProps.isOpen}
      onOpenChange={browserProps.onOpenChange}
      isDismissable
      dialogAriaLabel="Shared browser"
    >
      {content}
    </StudioDialogModal>
  );
}

/** Keep the optional viewer download separate from chat startup and readiness. */
export function createLazyBrowserSessionModal(
  load: () => Promise<{ BrowserSessionModal: ComponentType<BrowserSessionModalProps> }>,
) {
  const createViewer = () => lazy(async () => ({ default: (await load()).BrowserSessionModal }));
  // Both callers share a settled lazy component, including after a failed-load
  // retry. Hiding a browser only updates props; it never changes this identity.
  let sharedViewer = createViewer();

  return function LazyBrowserSession(props: BrowserSessionModalProps) {
    const [Viewer, setViewer] = useState(() => sharedViewer);
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => {
      sharedViewer = createViewer();
      setViewer(() => sharedViewer);
      setAttempt((current) => current + 1);
    }, []);

    return (
      <BrowserCodeErrorBoundary key={attempt} fallback={<BrowserCodeFallback browserProps={props} retry={retry} />}>
        <Suspense fallback={<BrowserCodeFallback browserProps={props} />}>
          <Viewer {...props} />
        </Suspense>
      </BrowserCodeErrorBoundary>
    );
  };
}

export const LazyBrowserSessionModal = createLazyBrowserSessionModal(() => import("./BrowserSessionModal"));
