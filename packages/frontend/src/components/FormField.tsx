import type { PropsWithChildren, ReactNode } from "react";
import { Text } from "./Text";

type FormFieldProps = PropsWithChildren<{
  label: string;
  hint?: ReactNode;
}>;

export function FormField({ label, hint, children }: FormFieldProps) {
  return (
    <label className="block">
      <Text as="span" variant="bodyStrong" tone="primary">
        {label}
      </Text>
      {hint ? (
        <Text as="span" variant="caption" tone="muted" className="ml-2">
          {hint}
        </Text>
      ) : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}
