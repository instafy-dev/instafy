import { Component, createRef, type ReactNode } from "react";

type Position = { top: number; left: number };
const positions = new Map<string, Position>();
const MAX_POSITIONS = 200;
const RESTORE_TIMEOUT_MS = 10_000;

export function buildStudioPanelScrollIdentity(input: {
  userId: string | null | undefined;
  projectId: string | null | undefined;
  visitKey: string;
  panel: string;
  section?: string | null;
}): string | null {
  if (!input.userId || !input.visitKey) return null;
  return JSON.stringify([input.userId, input.projectId ?? null, input.visitKey, input.panel, input.section ?? null]);
}

function remember(identity: string, position: Position): void {
  positions.delete(identity);
  positions.set(identity, position);
  while (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value!);
}

type Props = {
  /** Account + project + history visit + panel/section, never just the URL. */
  identity: string | null;
  /** False while the incoming route and the rendered workspace disagree. */
  ready: boolean;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
};

/**
 * The actual scroll owner. Capture before React replaces outgoing content (a
 * hook cleanup is too late when a shorter next panel has already clamped it).
 * Only in-memory coordinates are retained; new history visits start at zero.
 */
export class StudioPanelScrollContainer extends Component<Props> {
  private readonly port = createRef<HTMLDivElement>();
  private readonly content = createRef<HTMLDivElement>();
  private restoring: { identity: string; position: Position } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private frame: number | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  componentDidMount(): void {
    this.restore();
  }

  getSnapshotBeforeUpdate(previous: Props): null {
    if (previous.identity !== this.props.identity || previous.ready !== this.props.ready) {
      this.capture(previous);
    }
    return null;
  }

  componentDidUpdate(previous: Props): void {
    if (previous.identity !== this.props.identity || previous.ready !== this.props.ready) {
      this.cancelRestore();
      this.restore();
    } else {
      this.tryRestore();
    }
  }

  componentWillUnmount(): void {
    this.capture(this.props);
    this.cancelRestore();
  }

  private capture(props: Props): void {
    const port = this.port.current;
    // Do not overwrite an unreachable saved target with a loading placeholder's
    // clamped position when the user rapidly leaves before content is ready.
    if (!port || !props.ready || !props.identity || this.restoring?.identity === props.identity) return;
    remember(props.identity, { top: port.scrollTop, left: port.scrollLeft });
  }

  private restore(): void {
    const { identity, ready } = this.props;
    const port = this.port.current;
    if (!port || !identity || !ready) return;
    const position = positions.get(identity) ?? { top: 0, left: 0 };
    this.restoring = { identity, position };
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.scheduleRestore);
      this.resizeObserver.observe(port);
      if (this.content.current) this.resizeObserver.observe(this.content.current);
    }
    if (typeof MutationObserver !== "undefined" && this.content.current) {
      this.mutationObserver = new MutationObserver(this.scheduleRestore);
      this.mutationObserver.observe(this.content.current, { subtree: true, childList: true, characterData: true });
    }
    this.deadline = setTimeout(this.cancelRestore, RESTORE_TIMEOUT_MS);
    this.tryRestore();
  }

  private scheduleRestore = (): void => {
    if (!this.restoring || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.tryRestore();
    });
  };

  private tryRestore = (): void => {
    const port = this.port.current;
    const pending = this.restoring;
    if (!port || !pending) return;
    port.scrollTop = pending.position.top;
    port.scrollLeft = pending.position.left;
    if (Math.abs(port.scrollTop - pending.position.top) < 1 && Math.abs(port.scrollLeft - pending.position.left) < 1) {
      this.cancelRestore();
    }
  };

  private cancelRestore = (): void => {
    this.restoring = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
  };

  render(): ReactNode {
    return (
      <div
        ref={this.port}
        className={this.props.className}
        data-testid={this.props["data-testid"]}
        onWheelCapture={this.cancelRestore}
        onTouchStartCapture={this.cancelRestore}
        onPointerDownCapture={this.cancelRestore}
        onKeyDownCapture={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) this.cancelRestore();
        }}
      >
        <div ref={this.content}>{this.props.children}</div>
      </div>
    );
  }
}
