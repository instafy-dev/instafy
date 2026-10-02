import { useEffect, useMemo, useRef, useState } from "react";
import { Check, NavArrowDown } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { StudioListBox, StudioListBoxItem } from "../../../components/aria/StudioListBox";
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
  presentation?: "menu" | "inline";
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
  presentation = "menu",
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

  const selectModel = (model: string | null) => {
    if (disabled) return;
    onSelect(model);
    setMenuOpen(false);
  };
  const customControls = (
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
          if (event.key === "Enter" && !event.nativeEvent.isComposing && canUseCustom) {
            event.preventDefault();
            selectModel(customDraft.trim());
          }
        }}
      />
      <Button
        variant="outline"
        size="sm"
        radius="full"
        fullWidth
        isDisabled={!canUseCustom}
        onPress={() => { if (canUseCustom) selectModel(customDraft.trim()); }}
        data-testid={triggerTestId ? `${triggerTestId}-custom-apply` : undefined}
      >
        Use custom model
      </Button>
    </div>
  );

  if (presentation === "inline") {
    const choices = includeDefaultOption
      ? [{ id: "__default__", label: defaultLabel }, ...options]
      : options;
    return (
      <div data-testid={triggerTestId}>
        {choices.length > 0 ? <StudioListBox
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={selectedKeys}
          disabledKeys={disabled ? choices.map((option) => option.id) : []}
          onSelectionChange={(keys) => {
            if (keys === "all") return;
            const key = keys.values().next().value;
            if (key !== undefined) selectModel(key === "__default__" ? null : String(key));
          }}
          className="space-y-1"
          data-testid={menuTestId}
        >
          {choices.map((option) => (
            <StudioListBoxItem key={option.id} id={option.id} textValue={option.label} className="min-h-11 gap-2">
              {({ isSelected }) => <>
                <span className="min-w-0 break-words">{option.label}</span>
                {isSelected ? <Check aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
              </>}
            </StudioListBoxItem>
          ))}
        </StudioListBox> : null}
        {customControls}
      </div>
    );
  }

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
        className="min-h-11 sm:pointer-fine:min-h-[38px] justify-between bg-slate-50 shadow-none hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:bg-[var(--color-studio-dark-raised-control)] dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)]"
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
        data-testid={menuTestId}
      >
        <StudioMenu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={selectedKeys}
          onAction={(key) => {
            const resolvedKey = String(key);
            selectModel(resolvedKey === "__default__" ? null : resolvedKey);
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
        {customControls}
      </StudioPopover>
    </MenuTrigger>
  );
}
