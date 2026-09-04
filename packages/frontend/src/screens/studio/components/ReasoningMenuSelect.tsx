import { useMemo, useRef, useState } from "react";
import { NavArrowDown } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import {
  REASONING_EFFORT_OPTIONS,
  reasoningEffortLabel,
  type AiReasoningEffort,
} from "../../../utils/aiReasoning";

export interface ReasoningMenuSelectProps {
  value: AiReasoningEffort | null;
  disabled?: boolean;
  /** Label for the "inherit" choice (null value). */
  defaultLabel?: string;
  ariaLabel: string;
  onSelect: (effort: AiReasoningEffort | null) => void;
  triggerTestId?: string;
  menuTestId?: string;
}

const DEFAULT_KEY = "__default__";

/**
 * Reasoning-effort picker, a fixed-options sibling of ModelMenuSelect: the four
 * levels plus a "Default" (inherit) choice. No custom-value input — reasoning is
 * a closed set.
 */
export function ReasoningMenuSelect({
  value,
  disabled = false,
  defaultLabel = "Default",
  ariaLabel,
  onSelect,
  triggerTestId,
  menuTestId,
}: ReasoningMenuSelectProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const label = value ? reasoningEffortLabel(value) : defaultLabel;
  const selectedKeys = useMemo(() => new Set<string>([value ?? DEFAULT_KEY]), [value]);

  return (
    <MenuTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        radius="xl"
        fullWidth
        isDisabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        data-testid={triggerTestId}
        onPress={() => {
          if (!menuOpen) {
            setMenuOpen(true);
          }
        }}
        className="justify-between bg-slate-50 shadow-none hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:bg-[var(--color-studio-dark-raised-control)] dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)]"
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <NavArrowDown className="text-base text-slate-400" aria-hidden="true" />
      </Button>
      <StudioPopover
        triggerRef={triggerRef}
        isNonModal
        placement="bottom start"
        offset={6}
        className="min-w-[var(--trigger-width)] p-2"
        shouldCloseOnInteractOutside={(element) => {
          // Nested in the Runtime & AI popover — keep clicks within it "inside".
          if (element.closest('[data-popover-scope="runtime-selector"]')) {
            return false;
          }
          return true;
        }}
        data-testid={menuTestId}
      >
        <StudioMenu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={selectedKeys}
          onAction={(key) => {
            const resolved = String(key);
            onSelect(resolved === DEFAULT_KEY ? null : (resolved as AiReasoningEffort));
            setMenuOpen(false);
          }}
          className="space-y-1"
        >
          <StudioMenuItem id={DEFAULT_KEY}>{defaultLabel}</StudioMenuItem>
          {REASONING_EFFORT_OPTIONS.map((option) => (
            <StudioMenuItem key={option.id} id={option.id}>
              {option.label}
            </StudioMenuItem>
          ))}
        </StudioMenu>
      </StudioPopover>
    </MenuTrigger>
  );
}
