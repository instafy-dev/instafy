import type { ReactNode } from "react";
import { Card, type CardProps } from "../../../components/Card";

type SettingsSurfaceProps = {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
} & Pick<CardProps, "tone" | "padding">;

export function SettingsSurface({
  children,
  className,
  tone = "default",
  padding = "sm",
  "data-testid": dataTestId,
}: SettingsSurfaceProps) {
  return (
    <Card
      tone={tone}
      radius="2xl"
      shadow="none"
      padding={padding}
      className={className}
      data-testid={dataTestId}
    >
      {children}
    </Card>
  );
}
