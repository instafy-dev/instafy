import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { Textarea } from "../../../components/Textarea";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import { resolveAgentAvatarImageSrc, resolveAgentAvatarText } from "../../../utils/agentAvatar";
import type { AiModelOption, AiProviderId } from "../../../utils/aiProviderModels";
import { CredentialMenuSelect } from "./CredentialMenuSelect";
import { ModelMenuSelect } from "./ModelMenuSelect";
import { ProviderMenuSelect } from "./ProviderMenuSelect";

export type AgentProfileModalMode = "create" | "edit" | "octo";

type AgentProfileModalProps = {
  isOpen: boolean;
  mode: AgentProfileModalMode;
  title: string;
  subtitle?: string;
  pending?: boolean;
  credentialId?: string | null;
  credentials?: ControllerCredentialListItem[];
  onCredentialChange?: (credentialId: string) => void;
  onConnectCredential?: () => void;
  providerId?: AiProviderId;
  providerOptions?: Array<{ id: AiProviderId; label: string; disabled?: boolean }>;
  onProviderChange?: (providerId: AiProviderId) => void;
  modelId?: string | null;
  modelOptions?: AiModelOption[];
  onModelChange?: (modelId: string | null) => void;
  handle: string;
  onHandleChange: (value: string) => void;
  handleDisabled?: boolean;
  handlePlaceholder?: string;
  handleHelpText?: string;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  avatarImageUrl: string;
  onAvatarImageUrlChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  saveLabel?: string;
};

export function AgentProfileModal({
  isOpen,
  mode,
  title,
  subtitle,
  pending = false,
  credentialId = null,
  credentials,
  onCredentialChange,
  onConnectCredential,
  providerId,
  providerOptions,
  onProviderChange,
  modelId = null,
  modelOptions,
  onModelChange,
  handle,
  onHandleChange,
  handleDisabled = false,
  handlePlaceholder,
  handleHelpText,
  displayName,
  onDisplayNameChange,
  avatarImageUrl,
  onAvatarImageUrlChange,
  description,
  onDescriptionChange,
  onClose,
  onSave,
  saveLabel,
}: AgentProfileModalProps) {
  const effectiveSaveLabel =
    saveLabel ?? (mode === "create" ? "Create" : "Save");

  const showCredentialPicker =
    Boolean(credentials?.length) &&
    typeof onCredentialChange === "function";

  const showProviderPicker =
    Boolean(providerOptions?.length) && typeof onProviderChange === "function";

  const showModelPicker =
    Boolean(modelOptions?.length) && typeof onModelChange === "function";
  const avatarPreviewSrc = resolveAgentAvatarImageSrc({
    handle,
    avatarSeed: avatarImageUrl,
  });

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      isDismissable
      dialogAriaLabel={title}
      modalClassName="max-h-[calc(100dvh-2rem)] overflow-hidden"
      dialogClassName="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col"
      data-testid="agent-profile-modal"
    >
      <StudioDialogHeader
        title={title}
        description={subtitle}
        onClose={onClose}
        closeButtonDisabled={pending}
        closeLabel="Close"
        className="shrink-0"
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {showProviderPicker && providerId ? (
          <Field label="Provider">
            <ProviderMenuSelect
              value={providerId}
              options={providerOptions ?? []}
              disabled={pending}
              ariaLabel="Select AI provider for this bot"
              onSelect={(nextProvider) => {
                onProviderChange?.(nextProvider);
              }}
              triggerTestId="agent-profile-provider-select"
              menuTestId="agent-profile-provider-menu"
            />
          </Field>
        ) : null}

        {showCredentialPicker ? (
          <Field label="Credential">
            <CredentialMenuSelect
              value={credentialId}
              credentials={credentials ?? []}
              disabled={pending}
              ariaLabel="Select credential for this bot"
              placeholder="Select credential"
              onSelect={(nextCredentialId) => {
                if (!nextCredentialId) {
                  return;
                }
                onCredentialChange?.(nextCredentialId);
              }}
              onConnectNew={() => {
                onConnectCredential?.();
              }}
              triggerTestId="agent-profile-credential-select"
              menuTestId="agent-profile-credential-menu"
            />
          </Field>
        ) : null}

        {showModelPicker ? (
          <Field label="Model">
            <ModelMenuSelect
              value={modelId}
              options={modelOptions ?? []}
              disabled={pending}
              ariaLabel="Select model for this agent"
              onSelect={(nextModel) => {
                onModelChange?.(nextModel);
              }}
              triggerTestId="agent-profile-model-select"
              menuTestId="agent-profile-model-menu"
            />
          </Field>
        ) : null}

        <Field label="Handle" htmlFor="agent-profile-handle" hint={handleHelpText || undefined}>
          <Input
            id="agent-profile-handle"
            value={handle}
            onChange={(event) => onHandleChange(event.target.value)}
            placeholder={handlePlaceholder ?? "@bob"}
            size="sm"
            radius="xl"
            disabled={pending || handleDisabled}
            data-testid="agent-profile-handle-input"
          />
        </Field>

        <Field label="Display name" htmlFor="agent-profile-display-name">
          <Input
            id="agent-profile-display-name"
            value={displayName}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="Optional"
            size="sm"
            radius="xl"
            disabled={pending}
            data-testid="agent-profile-display-name-input"
          />
        </Field>

        <Field label="Profile picture URL" htmlFor="agent-profile-avatar-url">
          <Input
            id="agent-profile-avatar-url"
            value={avatarImageUrl}
            onChange={(event) => onAvatarImageUrlChange(event.target.value)}
            placeholder="https://example.com/avatar.png"
            size="sm"
            radius="xl"
            disabled={pending}
            data-testid="agent-profile-avatar-url-input"
          />
          <div className="mt-1 flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white text-3xs font-semibold text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {avatarPreviewSrc ? (
                <img src={avatarPreviewSrc} alt="" className="h-full w-full object-cover" decoding="async" draggable={false} />
              ) : (
                resolveAgentAvatarText({ handle, displayName })
              )}
            </span>
            <Text variant="caption" tone="muted" className="font-normal">
              Optional. Use `https://...`, `http://...`, or `/path`.
            </Text>
          </div>
        </Field>

        <Field label="Description" htmlFor="agent-profile-description">
          <Textarea
            id="agent-profile-description"
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="Short flavor text for this agent."
            rows={4}
            disabled={pending}
            data-testid="agent-profile-description-input"
          />
          <Text variant="caption" tone="muted" className="mt-1 font-normal">
            Used as style guidance; it does not override core system instructions.
          </Text>
        </Field>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
        <Button
          onPress={onClose}
          variant="ghost"
          size="sm"
          radius="full"
          isDisabled={pending}
        >
          Cancel
        </Button>
        <Button
          onPress={onSave}
          variant="primary"
          size="sm"
          radius="full"
          isDisabled={pending}
          data-testid="agent-profile-save"
        >
          {pending ? "Working…" : effectiveSaveLabel}
        </Button>
      </div>
    </StudioDialogModal>
  );
}
