import { createContext, useId, useMemo, type ReactNode } from "react";
import { Text } from "./Text";
import type { TextTone, TextVariant } from "../styles/typography";

type FieldSize = "xs" | "sm" | "md";

/** External form labels must also reach controls whose ARIA implementation names itself. */
export const FieldLabelContext = createContext<{ controlId: string; labelId: string } | null>(null);

// One clean, sentence-case form-label look at every size — readable and quiet,
// not the uppercase "eyebrow" treatment (which belongs to section headers, not
// per-field labels). This is the single standard forms route through.
const LABEL_VARIANTS: Record<FieldSize, { variant: TextVariant; tone: TextTone }> = {
  xs: { variant: "captionSmallStrong", tone: "muted" },
  sm: { variant: "fieldLabel", tone: "secondary" },
  md: { variant: "bodyStrong", tone: "secondary" },
};

const HELP_VARIANTS: Record<FieldSize, { variant: TextVariant; tone: "muted" }> = {
  xs: { variant: "captionSmall", tone: "muted" },
  sm: { variant: "caption", tone: "muted" },
  md: { variant: "body", tone: "muted" },
};

export interface FieldProps {
  label?: string;
  htmlFor?: string;
  labelId?: string;
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
  labelId,
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
  const generatedId = useId();
  const resolvedLabelId = label ? labelId ?? `${generatedId}-label` : undefined;
  const labelContext = useMemo(() => htmlFor && resolvedLabelId
    ? { controlId: htmlFor, labelId: resolvedLabelId }
    : null, [htmlFor, resolvedLabelId]);

  return (
    <div className={["flex min-w-0 flex-col", size === "xs" ? "gap-1.5" : "gap-2", className].filter(Boolean).join(" ")}>
      {label ? (
        <Text
          as="label"
          id={resolvedLabelId}
          htmlFor={htmlFor}
          variant={labelVariant.variant}
          tone={labelVariant.tone}
          className={["block", labelClassName].filter(Boolean).join(" ")}
        >
          {label}
          {required ? <span className="ml-1 text-rose-500">*</span> : null}
        </Text>
      ) : null}
      <FieldLabelContext.Provider value={labelContext}>{children}</FieldLabelContext.Provider>
      {error ? (
        <Text
          as="p"
          variant="captionStrong"
          tone="danger"
          className={errorClassName}
        >
          {error}
        </Text>
      ) : hint ? (
        <Text
          as="p"
          variant={helpVariant.variant}
          tone={helpVariant.tone}
          className={hintClassName}
        >
          {hint}
        </Text>
      ) : null}
    </div>
  );
}
