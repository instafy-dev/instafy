import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { Dialog, DialogTrigger, type PopoverProps } from "react-aria-components";
import { StudioPopover } from "../../../components/aria/StudioPopover";

// Electron's native page sits above DOM content. The surface temporarily hides
// it while a browser tools overlay is open, preserving its viewport and session.
export const BrowserToolsOverlayContext = createContext<(() => () => void) | null>(null);

function ToolsDialog({ label, children }: { label: string; children: ReactNode }) {
  const register = useContext(BrowserToolsOverlayContext);
  useLayoutEffect(() => register?.(), [register]);
  return <Dialog aria-label={label} className="space-y-3 p-3 text-sm outline-none">{children}</Dialog>;
}

export function BrowserToolsPopover({ label, trigger, children, isOpen, onOpenChange, placement = "bottom end" }: {
  label: string;
  placement?: PopoverProps["placement"];
  trigger: ReactNode;
  children: ReactNode;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
    {trigger}
    <StudioPopover placement={placement} className="z-[90] w-80 max-w-[calc(100vw-1rem)]" offset={6}>
      <ToolsDialog label={label}>{children}</ToolsDialog>
    </StudioPopover>
  </DialogTrigger>;
}
