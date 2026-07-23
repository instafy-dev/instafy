import type { ReactNode } from "react";
import { Text } from "./Text";
import { DRAWER_SECTION_HEADER_BASE, DRAWER_SECTION_LABEL_CLASS } from "./listRowStyles";

interface SidebarMenuSectionProps {
  label: ReactNode;
  actions?: ReactNode;
  className?: string;
  headerClassName?: string;
  children?: ReactNode;
  contentClassName?: string;
}

export function SidebarMenuSection({
  label,
  actions,
  className,
  headerClassName,
  children,
  contentClassName,
}: SidebarMenuSectionProps) {
  return (
    <section className={className}>
      <div className={[DRAWER_SECTION_HEADER_BASE, headerClassName].filter(Boolean).join(" ")}>
        <Text as="p" variant="label" tone="subtle" className={DRAWER_SECTION_LABEL_CLASS}>
          {label}
        </Text>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children ? <div className={contentClassName}>{children}</div> : null}
    </section>
  );
}
