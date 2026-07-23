import { useEffect, useMemo, useRef, useState } from "react";
import { NavArrowDown } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import type { AiModelOption } from "../../../utils/aiProviderModels";

export interface ModelMenuSelectProps {
  options: AiModelOption[];
  value: string | null;
  disabled?: boolean;
  includeDefaultOption?: boolean;
  defaultLabel?: string;
  placeholder?: string;
  ariaLabel: string;
  onSelect: (model: string | null) => void;
  triggerTestId?: string;
  menuTestId?: string;
  customPlaceholder?: string;
  customLabel?: string;
}

export function ModelMenuSelect({
  options,
  value,
  disabled = false,
  includeDefaultOption = true,
  defaultLabel = "Default (recommended)",
  placeholder = "Select model",
  ariaLabel,
  onSelect,
  triggerTestId,
  menuTestId,
  customPlaceholder = "e.g. gpt-5.5-mini",
  customLabel = "Custom model id",
}: ModelMenuSelectProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const selectedOption = useMemo(() => {
    if (!value) {
      return null;
    }
    return options.find((option) => option.id === value) ?? null;
  }, [options, value]);

  const isCustomSelected = Boolean(value && !selectedOption);

  const label = value ? (selectedOption ? selectedOption.label : value) : includeDefaultOption ? defaultLabel : placeholder;

  const [customDraft, setCustomDraft] = useState("");
  useEffect(() => {
    if (isCustomSelected && value) {
      setCustomDraft(value);
      return;
    }
    setCustomDraft("");
  }, [isCustomSelected, value]);

  const selectedKeys = new Set<string>();
  if (value) {
    selectedKeys.add(value);
  } else if (includeDefaultOption) {
    selectedKeys.add("__default__");
  }

  const canUseCustom = !disabled && customDraft.trim().length > 0;

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
          // When nested in the Runtime & AI popover, treat clicks within that surface as "inside"
          // so the menu doesn't immediately close on the same click that opened it.
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
            const resolvedKey = String(key);
            if (resolvedKey === "__default__") {
              onSelect(null);
              setMenuOpen(false);
              return;
            }
            onSelect(resolvedKey);
            setMenuOpen(false);
          }}
          className="space-y-1"
        >
          {includeDefaultOption ? <StudioMenuItem id="__default__">{defaultLabel}</StudioMenuItem> : null}
          {options.map((option) => (
            <StudioMenuItem key={option.id} id={option.id}>
              {option.label}
            </StudioMenuItem>
          ))}
        </StudioMenu>
        <StudioMenuSeparator />
        <div className="space-y-1 px-1 pt-2">
          <Text as="div" variant="caption" tone="muted" className="font-medium">
            {customLabel}
          </Text>
          <Input
            value={customDraft}
            onChange={(event) => setCustomDraft(event.target.value)}
            placeholder={customPlaceholder}
            size="sm"
            radius="xl"
            disabled={disabled}
            aria-label={`${ariaLabel}: custom model id`}
            data-testid={triggerTestId ? `${triggerTestId}-custom-input` : undefined}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              if (!canUseCustom) {
                return;
              }
              event.preventDefault();
              onSelect(customDraft.trim());
              setMenuOpen(false);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            radius="full"
            fullWidth
            isDisabled={!canUseCustom}
            onPress={() => {
              if (!canUseCustom) {
                return;
              }
              onSelect(customDraft.trim());
              setMenuOpen(false);
            }}
            data-testid={triggerTestId ? `${triggerTestId}-custom-apply` : undefined}
          >
            Use custom model
          </Button>
        </div>
      </StudioPopover>
    </MenuTrigger>
  );
}
