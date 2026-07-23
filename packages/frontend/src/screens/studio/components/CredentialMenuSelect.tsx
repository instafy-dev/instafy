import { useRef, useState } from "react";
import { NavArrowDown } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem, StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import { formatCredentialOptionLabel } from "../../../utils/credentialFormatting";

export interface CredentialMenuSelectProps {
  credentials: ControllerCredentialListItem[];
  value: string | null;
  disabled?: boolean;
  includeAccountDefaultOption?: boolean;
  accountDefaultLabel?: string;
  placeholder?: string;
  ariaLabel: string;
  onSelect: (credentialId: string | null) => void;
  onConnectNew: () => void;
  triggerTestId?: string;
  menuTestId?: string;
}

export function CredentialMenuSelect({
  credentials,
  value,
  disabled = false,
  includeAccountDefaultOption = false,
  accountDefaultLabel = "Use account default",
  placeholder = "Select credential",
  ariaLabel,
  onSelect,
  onConnectNew,
  triggerTestId,
  menuTestId,
}: CredentialMenuSelectProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedCredential = value ? credentials.find((credential) => credential.id === value) ?? null : null;

  const label = value
    ? selectedCredential
      ? formatCredentialOptionLabel(selectedCredential)
      : "Unknown credential"
    : includeAccountDefaultOption
      ? accountDefaultLabel
      : placeholder;

  const selectedKeys = new Set<string>();
  if (value) {
    selectedKeys.add(value);
  } else if (includeAccountDefaultOption) {
    selectedKeys.add("__default__");
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
        shouldCloseOnInteractOutside={() => true}
        data-testid={menuTestId}
      >
        <StudioMenu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={selectedKeys}
          onAction={(key) => {
            const resolvedKey = String(key);
            if (resolvedKey === "__connect__") {
              onConnectNew();
              setMenuOpen(false);
              return;
            }
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
          {includeAccountDefaultOption ? <StudioMenuItem id="__default__">{accountDefaultLabel}</StudioMenuItem> : null}
          {credentials.map((credential) => (
            <StudioMenuItem key={credential.id} id={credential.id}>
              {formatCredentialOptionLabel(credential)}
            </StudioMenuItem>
          ))}
          <StudioMenuSeparator />
          <StudioMenuItem id="__connect__">Connect new credential…</StudioMenuItem>
        </StudioMenu>
      </StudioPopover>
    </MenuTrigger>
  );
}
