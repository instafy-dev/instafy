import type { ReactNode } from "react";
import { Text } from "./Text";

/** A one-off settings action on the page surface. Wrap the action, not its label. */
export function SettingsActionRow({ title, description, action, testId }: {
  title: string;
  description: string;
  action: ReactNode;
  testId?: string;
}) {
  return <section className="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid={testId}>
    <div className="min-w-0 grow basis-64">
      <Text as="h3" variant="bodyStrong" tone="primary">{title}</Text>
      <Text as="p" variant="caption" tone="muted" className="mt-1">{description}</Text>
    </div>
    <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{action}</div>
  </section>;
}
