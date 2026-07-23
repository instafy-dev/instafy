import type { ReactNode } from "react";
import { Surface, type SurfaceProps } from "./Surface";

type CardPadding = "sm" | "md" | "lg";

const PADDING_CLASSES: Record<CardPadding, string> = {
  sm: "p-3",
  md: "p-4",
  lg: "p-5"
};

export type CardProps = SurfaceProps & {
  padding?: CardPadding;
  children?: ReactNode;
};

export function Card({ padding = "md", className, ...props }: CardProps) {
  return (
    <Surface
      {...props}
      className={[PADDING_CLASSES[padding], className].filter(Boolean).join(" ")}
    />
  );
}
