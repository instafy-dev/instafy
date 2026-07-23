import type { ReactNode } from "react";
import { Checkbox } from "../../components/Checkbox";

interface RuntimeAutoToggleProps {
  enabled: boolean;
  onToggle: (nextEnabled: boolean) => void | Promise<void>;
  ariaLabel?: string;
  className?: string;
  label?: ReactNode;
  description?: ReactNode;
}

export function RuntimeAutoToggle({
  enabled,
  onToggle,
  ariaLabel,
  className,
  label,
  description,
}: RuntimeAutoToggleProps) {
  return (
    <Checkbox
      isSelected={enabled}
      onChange={(nextEnabled) => void onToggle(nextEnabled)}
      aria-label={ariaLabel}
      label={label ?? "Auto selection"}
      description={description}
      size="sm"
      className={className}
    />
  );
}
