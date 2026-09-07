import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Button } from "../components/Button";
import { LoadingStatus } from "../components/LoadingStatus";
import { StudioPanelPerformanceProbe } from "../telemetry/StudioPanelPerformance";

class PanelErrorBoundary extends Component<{
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

/** Keep optional panel downloads and their failures inside the selected panel. */
export function lazyStudioPanel<Props extends object>(
  label: string,
  load: () => Promise<{ default: ComponentType<Props> }>,
  renderFallback: (content: ReactNode, props: Props) => ReactNode = (content) => content,
) {
  // Share the settled component across visits so a warm panel does not suspend
  // again. Retrying replaces a rejected lazy component for future visits too.
  let sharedPanel = lazy(load);

  return function LazyStudioPanel(props: Props) {
    const [Panel, setPanel] = useState(() => sharedPanel);
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => {
      sharedPanel = lazy(load);
      setPanel(() => sharedPanel);
      setAttempt((current) => current + 1);
    }, []);
    const loading = renderFallback(
      <div className="flex h-full min-h-24 items-center justify-center p-4" data-testid="studio-panel-loading">
        <LoadingStatus>Loading {label.toLowerCase()}…</LoadingStatus>
      </div>,
      props,
    );
    const error = renderFallback(
      <div className="flex h-full min-h-24 flex-col items-center justify-center gap-3 p-4 text-center"
        data-testid="studio-panel-load-error">
        <p role="alert" className="text-sm text-slate-600 dark:text-slate-400">
          Couldn’t load {label.toLowerCase()}. Check your connection and try again.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" size="sm" onPress={retry}>Retry</Button>
          <Button variant="ghost" size="sm" onPress={() => window.location.reload()}>Reload app</Button>
        </div>
      </div>,
      props,
    );

    return (
      <PanelErrorBoundary key={attempt} fallback={<>{error}<StudioPanelPerformanceProbe error /></>}>
        <Suspense fallback={<>{loading}<StudioPanelPerformanceProbe loading /></>}>
          <Panel {...props} />
          <StudioPanelPerformanceProbe />
        </Suspense>
      </PanelErrorBoundary>
    );
  };
}
