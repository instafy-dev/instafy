import type { ReactNode } from "react";
import { Text } from "../../../components/Text";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";

interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  descriptionVisibility?: "always" | "desktop";
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function SettingsSection({
  title,
  description,
  descriptionVisibility = "always",
  actions,
  children,
  className,
  "data-testid": dataTestId,
}: SettingsSectionProps) {
  const isLargeScreen = useStudioDesktopLayout();
  const showDescription = Boolean(description && (descriptionVisibility === "always" || isLargeScreen));

  return (
    <section className={["space-y-3 px-1", className].filter(Boolean).join(" ")} data-testid={dataTestId}>
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <Text variant="bodyStrong" tone="secondary">
            {title}
          </Text>
          {showDescription ? (
            <Text variant="caption" tone="muted" className="mt-1">
              {description}
            </Text>
          ) : null}
        </div>
        {actions ? (
          <div className="flex min-w-0 w-full items-start gap-2 self-start sm:w-auto sm:shrink-0 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
