import type { ReactNode } from "react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";

export type ChatActionCardAction = {
  id: string;
  label: string;
  variant?: "primary" | "outline" | "ghost";
  onPress: () => void;
  isDisabled?: boolean;
  isLoading?: boolean;
  loadingLabel?: string | null;
  testId?: string;
};

export type ChatActionCardProps = {
  icon?: ReactNode;
  overline?: string | null;
  title: string;
  description?: string | null;
  children?: ReactNode;
  actions: ChatActionCardAction[];
  testId?: string;
  className?: string;
};

export function ChatActionCard({
  icon,
  overline,
  title,
  description,
  children,
  actions,
  testId,
  className,
}: ChatActionCardProps) {
  return (
    <Surface
      tone="default"
      radius="2xl"
      shadow="sm"
      data-testid={testId}
      className={
        className ??
        "max-w-[min(80%,42rem)] px-3 py-2.5 text-sm text-slate-700 dark:text-slate-200"
      }
    >
      <div className="space-y-1">
        {overline ? (
          <div className="flex items-center gap-2">
            {icon}
            <Text variant="label" tone="subtle">
              {overline}
            </Text>
          </div>
        ) : icon ? (
          <div className="flex items-center gap-2">{icon}</div>
        ) : null}
        <Text as="div" variant="bodyStrong" tone="primary">
          {title}
        </Text>
        {description ? (
          <Text as="div" variant="caption" tone="muted" className="leading-snug">
            {description}
          </Text>
        ) : null}
      </div>

      {children ? <div className="mt-3">{children}</div> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {actions.map((action) => {
          const loadingLabel = action.loadingLabel ?? action.label;
          return (
            <Button
              key={action.id}
              variant={action.variant ?? "outline"}
              size="sm"
              radius="full"
              onPress={action.onPress}
              isDisabled={action.isDisabled}
              data-testid={action.testId}
              className={action.isLoading ? "gap-2" : undefined}
            >
              {action.isLoading ? <Spinner aria-hidden="true" tone="primary" size="sm" /> : null}
              {action.isLoading ? loadingLabel : action.label}
            </Button>
          );
        })}
      </div>
    </Surface>
  );
}
