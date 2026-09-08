import { Component, type ReactNode } from "react";

type Props = {
  identity: string;
  messages: unknown;
  capture: () => void;
  children: ReactNode;
};

/** Hooks run after DOM mutation. Capture the outgoing transcript before React replaces it. */
export class ChatScrollSnapshotBoundary extends Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): null {
    if (previous.identity !== this.props.identity || previous.messages !== this.props.messages) {
      previous.capture();
    }
    return null;
  }

  componentDidUpdate(): void {
    // Required lifecycle pair; restoration belongs to the parent's layout effect.
  }

  componentWillUnmount(): void {
    this.props.capture();
  }

  render(): ReactNode {
    return this.props.children;
  }
}
