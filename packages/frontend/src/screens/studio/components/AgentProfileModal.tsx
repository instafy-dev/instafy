import { AgentAvatar } from "../../../components/AgentAvatar";
import { useEffect, useState } from "react";
import { IdentityPhotoButton } from "../../../components/IdentityPhotoButton";
import { SettingsFormLayout, SettingsIdentityRow } from "../../../components/SettingsFormLayout";
import { SettingsFormActions } from "../../../components/SettingsFormActions";
import { IDENTITY_IMAGE_ACCEPT, validateIdentityImage } from "../../../lib/identityImages";
import { PROFILE_BIO_MAX_LENGTH } from "@instafy/sdk/human-profiles";
import { ProfileBioField } from "../../../components/ProfileBioField";
import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { Textarea } from "../../../components/Textarea";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import { resolveAgentAvatarImageSrc } from "../../../utils/agentAvatar";
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
  avatarFile?: File | null;
  onAvatarFileChange?: (file: File | null) => void;
  avatarSeed?: string;
  dirty?: boolean;
  bio?: string;
  onBioChange?: (value: string) => void;
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
  avatarFile = null,
  onAvatarFileChange,
  avatarSeed,
  dirty = true,
  bio = "",
  onBioChange,
  description,
  onDescriptionChange,
  onClose,
  onSave,
  saveLabel,
}: AgentProfileModalProps) {
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = isOpen && avatarFile ? URL.createObjectURL(avatarFile) : null;
    setPreviewUrl(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [isOpen, avatarFile]);
  useEffect(() => { if (!isOpen) setPhotoError(null); }, [isOpen]);
  const effectiveSaveLabel =
    saveLabel ?? (mode === "create" ? "Create" : "Save");

  const showCredentialPicker =
    Boolean(credentials?.length) &&
    typeof onCredentialChange === "function";

  const showProviderPicker =
    Boolean(providerOptions?.length) && typeof onProviderChange === "function";

  const showModelPicker =
    Boolean(modelOptions?.length) && typeof onModelChange === "function";
  const avatarPreviewSrc = previewUrl ?? resolveAgentAvatarImageSrc({
    handle,
    avatarSeed: avatarImageUrl,
  });

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <SettingsFormLayout>
          <SettingsIdentityRow>
            <IdentityPhotoButton
              label={avatarImageUrl || avatarFile ? "Change bot picture" : "Upload bot picture"}
              accept={IDENTITY_IMAGE_ACCEPT}
              disabled={pending || !onAvatarFileChange}
              inputTestId="agent-profile-picture-input"
              onSelect={(file) => {
                const error = validateIdentityImage(file);
                setPhotoError(error);
                if (!error) onAvatarFileChange?.(file);
              }}
            >
              <AgentAvatar agent={{ handle, displayName, avatarSeed }} size="lg" imageSrc={avatarPreviewSrc} />
            </IdentityPhotoButton>
            <Field label="Display name" htmlFor="agent-profile-display-name">
              <Input id="agent-profile-display-name" value={displayName}
                onChange={(event) => onDisplayNameChange(event.target.value)} disabled={pending}
                data-testid="agent-profile-display-name-input" />
            </Field>
          </SettingsIdentityRow>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text as="p" variant="caption" tone="muted">PNG, JPEG or WebP, up to 2 MB.</Text>
            {avatarImageUrl || avatarFile ? <Button variant="ghost" size="sm" radius="xl" className="min-h-11 sm:pointer-fine:min-h-9" isDisabled={pending}
              onPress={() => { onAvatarFileChange?.(null); onAvatarImageUrlChange(""); setPhotoError(null); }}>
              Remove picture
            </Button> : null}
          </div>
          {photoError ? <Text as="p" role="alert" variant="caption" tone="danger">{photoError}</Text> : null}
          <Field label="Handle" htmlFor="agent-profile-handle" hint={handleHelpText || undefined}>
            <Input
              id="agent-profile-handle"
              value={handle}
              onChange={(event) => onHandleChange(event.target.value)}
              placeholder={handlePlaceholder ?? "@bob"}
              radius="xl"
              disabled={pending || handleDisabled}
              data-testid="agent-profile-handle-input"
            />
          </Field>

          {onBioChange ? <ProfileBioField id="agent-profile-bio" value={bio} onChange={onBioChange} disabled={pending} isAgent /> : null}

          <section className="space-y-4 border-t border-slate-200/70 pt-5 dark:border-[color:var(--color-studio-dark-divider)]" aria-label="Bot behavior">
            <div>
              <Text as="h3" variant="bodyStrong" tone="primary">Bot behavior</Text>
              <Text as="p" variant="caption" tone="muted" className="mt-1">Connection, model and response preferences. These are separate from the public profile.</Text>
            </div>
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

            <Field label="Style guidance" htmlFor="agent-profile-description">
              <Textarea
                id="agent-profile-description"
                value={description}
                onChange={(event) => onDescriptionChange(event.target.value)}
                placeholder="For example: keep replies concise and practical."
                rows={4}
                disabled={pending}
                data-testid="agent-profile-description-input"
              />
              <Text variant="caption" tone="muted" className="mt-1 font-normal">
                Used as style guidance; it does not override core system instructions.
              </Text>
            </Field>
          </section>
        </SettingsFormLayout>
      </div>

      <div className="shrink-0 px-5 pb-4">
        <SettingsFormActions saveLabel={effectiveSaveLabel} saving={pending}
          disabled={!dirty || Array.from(bio).length > PROFILE_BIO_MAX_LENGTH}
          onSave={onSave} onCancel={onClose} saveTestId="agent-profile-save" />
      </div>
    </StudioDialogModal>
  );
}
