import { useEffect, useRef, useState } from "react";
import { NavArrowDown } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "./Button";
import { StudioPopover } from "./aria/StudioPopover";
import { StudioMenu, StudioMenuItem } from "./aria/StudioMenu";

export interface ToolbarMenuSelectOption {
  id: string;
  label: string;
}

export interface ToolbarMenuSelectProps {
  options: ToolbarMenuSelectOption[];
  value: string;
  ariaLabel: string;
  onSelect: (value: string) => void;
  className?: string;
  triggerTestId?: string;
  menuTestId?: string;
}

const TRIGGER_CLASS =
  "h-10 min-w-[8rem] justify-between gap-2 rounded-full border border-slate-200/70 bg-slate-50/80 px-3.5 text-sm font-medium text-slate-700 shadow-none hover:border-slate-300 hover:bg-slate-50 data-[hovered]:border-slate-300 data-[hovered]:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:border-slate-700 dark:hover:bg-slate-900 dark:data-[hovered]:border-slate-700 dark:data-[hovered]:bg-slate-900";

export function ToolbarMenuSelect({
  options,
  value,
  ariaLabel,
  onSelect,
  className,
  triggerTestId,
  menuTestId,
}: ToolbarMenuSelectProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuContentRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedLabel = options.find((option) => option.id === value)?.label ?? options[0]?.label ?? "";
  const selectedKeys = new Set<string>(value ? [value] : []);

  useEffect(() => {
    if (!menuOpen || typeof document === "undefined") {
      return;
    }
    const ownerDocument = triggerRef.current?.ownerDocument ?? document;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (triggerRef.current?.contains(target) || menuContentRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    ownerDocument.addEventListener("pointerdown", handlePointerDown, true);
    ownerDocument.addEventListener("keydown", handleKeyDown, true);
    return () => {
      ownerDocument.removeEventListener("pointerdown", handlePointerDown, true);
      ownerDocument.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [menuOpen]);

  return (
    <MenuTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        radius="full"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        data-testid={triggerTestId}
        onPress={() => {
          if (!menuOpen) {
            setMenuOpen(true);
          }
        }}
        className={[TRIGGER_CLASS, className].filter(Boolean).join(" ")}
      >
        <span className="min-w-0 flex-1 truncate text-left leading-none">{selectedLabel}</span>
        <NavArrowDown className="text-sm text-slate-400 dark:text-slate-500" aria-hidden="true" />
      </Button>
      <StudioPopover
        triggerRef={triggerRef}
        isNonModal
        placement="bottom end"
        offset={6}
        className="min-w-[var(--trigger-width)] p-1"
        shouldCloseOnInteractOutside={() => true}
        data-testid={menuTestId}
      >
        <div ref={menuContentRef}>
          <StudioMenu
            aria-label={ariaLabel}
            selectionMode="single"
            selectedKeys={selectedKeys}
            onAction={(key) => {
              onSelect(String(key));
              setMenuOpen(false);
            }}
            className="space-y-1"
          >
            {options.map((option) => (
              <StudioMenuItem key={option.id} id={option.id}>
                {option.label}
              </StudioMenuItem>
            ))}
          </StudioMenu>
        </div>
      </StudioPopover>
    </MenuTrigger>
  );
}
