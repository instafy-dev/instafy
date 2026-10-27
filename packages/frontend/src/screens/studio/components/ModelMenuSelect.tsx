import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { StudioListBox, StudioListBoxItem } from "../../../components/aria/StudioListBox";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { FormPickerPopover, FormPickerTrigger } from "../../../components/FormPicker";
import { DEFAULT_PROJECT_AI_MODEL } from "../../../ai/modelDefaults";
import type { AiModelOption } from "../../../utils/aiProviderModels";

export interface ModelMenuSelectProps {
  options: AiModelOption[];
  value: string | null;
  disabled?: boolean;
  includeDefaultOption?: boolean;
  defaultLabel?: string;
  placeholder?: string;
  ariaLabel: string;
  id?: string;
  ariaLabelledBy?: string;
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
  id,
  ariaLabelledBy,
  onSelect,
  triggerTestId,
  menuTestId,
  customPlaceholder = `e.g. ${DEFAULT_PROJECT_AI_MODEL}`,
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
          id={id}
          aria-label={ariaLabelledBy ? undefined : ariaLabel}
          aria-labelledby={ariaLabelledBy}
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
      <FormPickerTrigger
        ref={triggerRef}
        id={id}
        isDisabled={disabled}
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-testid={triggerTestId}
        onPress={() => {
          if (!menuOpen) {
            setMenuOpen(true);
          }
        }}
      >
        {label}
      </FormPickerTrigger>
      <FormPickerPopover
        triggerRef={triggerRef}
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
      </FormPickerPopover>
    </MenuTrigger>
  );
}
