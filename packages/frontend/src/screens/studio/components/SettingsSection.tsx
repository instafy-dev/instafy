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
    <section className={["@container/settings-section space-y-3", className].filter(Boolean).join(" ")} data-testid={dataTestId}>
      <div className="flex flex-col gap-2 @min-[28rem]/settings-section:grid @min-[28rem]/settings-section:grid-cols-[minmax(0,1fr)_auto] @min-[28rem]/settings-section:items-start">
        <div className="min-w-0">
          <Text as="h3" variant="bodyStrong" tone="primary">
            {title}
          </Text>
          {showDescription ? (
            <Text variant="caption" tone="muted" className="mt-1">
              {description}
            </Text>
          ) : null}
        </div>
        {actions ? (
          <div className="flex min-w-0 w-full flex-wrap items-start gap-2 self-start @min-[28rem]/settings-section:w-auto @min-[28rem]/settings-section:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
