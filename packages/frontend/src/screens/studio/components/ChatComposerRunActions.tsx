import { Fragment, type ReactNode } from "react";
import { ChatRunStopControl } from "./ChatRunStopControl";
import type { ChatRunStopController } from "./useChatRunStop";

type ChatComposerRunActionsProps = {
  controller?: ChatRunStopController | null;
  hasUsablePayload: boolean;
  voiceCaptureInProgress: boolean;
  mutationDisabled?: boolean;
  primaryAction: ReactNode;
  actionClassName?: string;
  iconClassName?: string;
};

export function resolveComposerRunStopPlacement({
  controller, hasUsablePayload, voiceCaptureInProgress, mutationDisabled,
}: Omit<ChatComposerRunActionsProps, "primaryAction">): "hidden" | "primary" | "secondary" {
  if (!controller?.visible || mutationDisabled) return "hidden";
  return hasUsablePayload || voiceCaptureInProgress ? "secondary" : "primary";
}

/** Both inline and expanded voice controls keep their existing action node during capture. */
export function ChatComposerRunActions(props: ChatComposerRunActionsProps) {
  const placement = resolveComposerRunStopPlacement(props);
  return <>
    {placement !== "hidden" && props.controller ? <ChatRunStopControl
      controller={props.controller} className={props.actionClassName} iconClassName={props.iconClassName}
    /> : null}
    {placement !== "primary" ? <Fragment key="primary-action">{props.primaryAction}</Fragment> : null}
  </>;
}
