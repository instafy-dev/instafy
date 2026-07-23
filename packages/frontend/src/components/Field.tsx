import type { ReactNode } from "react";
import { Text } from "./Text";
import type { TextTone, TextVariant } from "../styles/typography";

type FieldSize = "xs" | "sm" | "md";

// One clean, sentence-case form-label look at every size — readable and quiet,
// not the uppercase "eyebrow" treatment (which belongs to section headers, not
// per-field labels). This is the single standard forms route through.
const LABEL_VARIANTS: Record<FieldSize, { variant: TextVariant; tone: TextTone; className: string }> = {
  xs: { variant: "caption", tone: "muted", className: "text-xxs font-medium" },
  sm: { variant: "caption", tone: "muted", className: "font-medium" },
  md: { variant: "bodyStrong", tone: "secondary", className: "" },
};

const HELP_VARIANTS: Record<FieldSize, { variant: "caption" | "body"; tone: "muted"; className?: string }> = {
  xs: { variant: "caption", tone: "muted", className: "text-xxs" },
  sm: { variant: "caption", tone: "muted" },
  md: { variant: "body", tone: "muted" },
};

export interface FieldProps {
  label?: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  size?: FieldSize;
  className?: string;
  labelClassName?: string;
  hintClassName?: string;
  errorClassName?: string;
  children: ReactNode;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  size = "sm",
  className,
  labelClassName,
  hintClassName,
  errorClassName,
  children,
}: FieldProps) {
  const labelVariant = LABEL_VARIANTS[size];
  const helpVariant = HELP_VARIANTS[size];

  return (
    <div className={["space-y-1.5", className].filter(Boolean).join(" ")}>
      {label ? (
        <Text
          as="label"
          htmlFor={htmlFor}
          variant={labelVariant.variant}
          tone={labelVariant.tone}
          className={[labelVariant.className, labelClassName].filter(Boolean).join(" ") || undefined}
        >
          {label}
          {required ? <span className="ml-1 text-rose-500">*</span> : null}
        </Text>
      ) : null}
      {children}
      {error ? (
        <Text
          as="p"
          variant="caption"
          tone="danger"
          className={["font-medium", errorClassName].filter(Boolean).join(" ")}
        >
          {error}
        </Text>
      ) : hint ? (
        <Text
          as="p"
          variant={helpVariant.variant}
          tone={helpVariant.tone}
          className={[helpVariant.className, hintClassName].filter(Boolean).join(" ")}
        >
          {hint}
        </Text>
      ) : null}
    </div>
  );
}
