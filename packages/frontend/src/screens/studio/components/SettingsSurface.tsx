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
  const surfaceClassName =
    tone === "default"
      ? "border-slate-200/70 bg-white/98 backdrop-blur-sm dark:border-slate-800/85 dark:bg-slate-950/84"
      : tone === "muted"
        ? "border-slate-200/70 bg-slate-50/78 backdrop-blur-sm dark:border-slate-800/85 dark:bg-slate-900/58"
        : tone === "subtle"
          ? "border-slate-200/70 bg-white/96 backdrop-blur-sm dark:border-slate-800/85 dark:bg-slate-950/78"
          : "";

  return (
    <Card
      tone={tone}
      radius="2xl"
      shadow="none"
      padding={padding}
      className={["py-2.5", surfaceClassName, className].filter(Boolean).join(" ")}
      data-testid={dataTestId}
    >
      {children}
    </Card>
  );
}
