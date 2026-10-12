import { useRef, useState } from "react";
import { MenuTrigger } from "react-aria-components";
import { FormPickerPopover, FormPickerTrigger } from "../../../components/FormPicker";
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
  id?: string;
  ariaLabelledBy?: string;
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
  id,
  ariaLabelledBy,
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
      </FormPickerPopover>
    </MenuTrigger>
  );
}
