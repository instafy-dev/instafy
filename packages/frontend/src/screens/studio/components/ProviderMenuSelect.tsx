import { useRef, useState } from "react";
import { NavArrowDown } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { DeepSeekIcon, GeminiIcon, OpenAIIcon, ZaiIcon } from "../../../components/ProviderIcons";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
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
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
          {providerIcon(value)}
          <span className="truncate">{label}</span>
        </span>
        <NavArrowDown className="text-base text-slate-400" aria-hidden="true" />
      </Button>
      <StudioPopover
        triggerRef={triggerRef}
        isNonModal
        placement="bottom start"
        offset={6}
        className="min-w-[var(--trigger-width)] p-2"
        shouldCloseOnInteractOutside={() => true}
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
      </StudioPopover>
    </MenuTrigger>
  );
}
