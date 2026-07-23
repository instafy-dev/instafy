import type { TextTone, TextVariant } from "../styles/typography";
import { Text } from "./Text";

export type FactGridItem = {
  label: string;
  value: string;
  labelTestId?: string;
  valueTestId?: string;
};

type FactGridProps = {
  items: FactGridItem[];
  columns?: 1 | 2;
  valueVariant?: Extract<TextVariant, "body" | "bodyStrong" | "caption">;
  valueTone?: TextTone;
  className?: string;
};

export function FactGrid({
  items,
  columns = 2,
  valueVariant = "bodyStrong",
  valueTone = "secondary",
  className,
}: FactGridProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <dl
      className={[
        "grid gap-2",
        columns === 2 ? "sm:grid-cols-2" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {items.map((fact) => (
        <div key={`${fact.label}:${fact.value}`} className="space-y-1">
          <Text as="dt" variant="caption" tone="muted" data-testid={fact.labelTestId}>
            {fact.label}
          </Text>
          <Text as="dd" variant={valueVariant} tone={valueTone} data-testid={fact.valueTestId}>
            {fact.value}
          </Text>
        </div>
      ))}
    </dl>
  );
}
