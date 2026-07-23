import type { ComponentPropsWithoutRef, ElementType } from "react";
import { Text } from "./Text";
import type { TextTone, TextVariant } from "../styles/typography";

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const DEFAULT_VARIANTS: Record<HeadingLevel, TextVariant> = {
  1: "display",
  2: "title",
  3: "subtitle",
  4: "bodyStrong",
  5: "bodyStrong",
  6: "label",
};

type HeadingProps<T extends ElementType> = ComponentPropsWithoutRef<T> & {
  as?: T;
  level?: HeadingLevel;
  variant?: TextVariant;
  tone?: TextTone;
};

export function Heading<T extends ElementType = "h2">({
  as,
  level,
  variant,
  tone = "primary",
  ...props
}: HeadingProps<T>) {
  const resolvedLevel = level ?? 2;
  const Component = as ?? (`h${resolvedLevel}` as ElementType);
  const resolvedVariant = variant ?? DEFAULT_VARIANTS[resolvedLevel];

  return (
    <Text as={Component} variant={resolvedVariant} tone={tone} {...props} />
  );
}
