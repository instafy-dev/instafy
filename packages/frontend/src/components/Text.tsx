import type { ComponentPropsWithoutRef, ElementType } from "react";
import { textTones, textVariants, type TextTone, type TextVariant } from "../styles/typography";

type TextProps<T extends ElementType> = ComponentPropsWithoutRef<T> & {
  as?: T;
  variant?: TextVariant;
  tone?: TextTone;
};

export function Text<T extends ElementType = "p">({
  as,
  variant = "body",
  tone = "secondary",
  className,
  ...props
}: TextProps<T>) {
  const Component = as ?? "p";
  return (
    <Component
      {...props}
      className={[textVariants[variant], textTones[tone], className].filter(Boolean).join(" ")}
    />
  );
}
