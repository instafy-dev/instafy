import { useRef, useState } from "react";
import { MenuTrigger } from "react-aria-components";
import { DeepSeekIcon, GeminiIcon, OpenAIIcon, ZaiIcon } from "../../../components/ProviderIcons";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { FormPickerPopover, FormPickerTrigger } from "../../../components/FormPicker";
import type { AiProviderId } from "../../../utils/aiProviderModels";

type ProviderMenuOption = {
  id: AiProviderId;
  label: string;
  disabled?: boolean;
};

export interface ProviderMenuSelectProps {
  options: ProviderMenuOption[];
  value: AiProviderId;
  disabled?: boolean;
  ariaLabel: string;
  id?: string;
  ariaLabelledBy?: string;
  onSelect: (provider: AiProviderId) => void;
  triggerTestId?: string;
  menuTestId?: string;
}

function providerIcon(provider: AiProviderId) {
  const className = "h-4 w-4";
  switch (provider) {
    case "deepseek":
      return <DeepSeekIcon className={className} />;
    case "zai":
      return <ZaiIcon className={className} />;
    case "gemini":
      return <GeminiIcon className={className} />;
    case "openai":
    default:
      return <OpenAIIcon className={className} />;
  }
}

export function ProviderMenuSelect({
  options,
  value,
  disabled = false,
  ariaLabel,
  id,
  ariaLabelledBy,
  onSelect,
  triggerTestId,
  menuTestId,
}: ProviderMenuSelectProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const selected = options.find((option) => option.id === value) ?? null;
  const label = selected ? selected.label : "Select provider";

  const selectedKeys = new Set<string>([value]);

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
        leading={providerIcon(value)}
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
            const resolved = String(key) as AiProviderId;
            onSelect(resolved);
            setMenuOpen(false);
          }}
          className="space-y-1"
        >
          {options.map((option) => (
            <StudioMenuItem key={option.id} id={option.id} isDisabled={option.disabled}>
              <span className="flex items-center gap-2">
                {providerIcon(option.id)}
                <span>{option.label}</span>
              </span>
            </StudioMenuItem>
          ))}
        </StudioMenu>
      </FormPickerPopover>
    </MenuTrigger>
  );
}
