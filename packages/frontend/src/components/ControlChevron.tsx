import { NavArrowDown } from "iconoir-react";

/** A secondary indicator inside a control; the parent owns the hit target and ARIA state. */
export function ControlChevron({ direction = "down" }: { direction?: "down" | "right" | "left" }) {
  return (
    <NavArrowDown
      aria-hidden="true"
      width={16}
      height={16}
      strokeWidth={1.5}
      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform motion-reduce:transition-none ${direction === "right" ? "-rotate-90" : direction === "left" ? "rotate-90" : ""}`}
    />
  );
}
