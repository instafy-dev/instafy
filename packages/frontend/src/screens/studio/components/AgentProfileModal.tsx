import { AgentAvatar } from "../../../components/AgentAvatar";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { useStudioDialogGutterClass } from "../../../components/aria/StudioDialogSpacing";
import { Textarea } from "../../../components/Textarea";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { MobileFocusDialog } from "../../../components/aria/MobileFocusDialog";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import type { ControllerCredentialListItem } from "../../../sdk/instafy";
import { normalizeCustomAgentAvatarSrc } from "../../../utils/agentAvatar";
import { hatchlingSeed, type Hatchling } from "../../../utils/aiFace";
import type { AiModelOption, AiProviderId } from "../../../utils/aiProviderModels";
import { AgentFacePicker } from "./AgentFacePicker";
import { CredentialMenuSelect } from "./CredentialMenuSelect";
import { ModelMenuSelect } from "./ModelMenuSelect";
import { ProviderMenuSelect } from "./ProviderMenuSelect";

export type AgentProfileModalMode = "create" | "edit" | "octo";

function AgentProfileFooter({ children }: { children: ReactNode }) {
  const gutterClass = useStudioDialogGutterClass();
  // SettingsFormActions owns the inset divider and the space above its buttons.
  return <StudioDialogFooter className={`${gutterClass} pb-4`}>{children}</StudioDialogFooter>;
}

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
  handleRequired?: boolean;
  connectionHint?: string;
  handlePlaceholder?: string;
  handleHelpText?: string;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  avatarImageUrl: string;
  onAvatarImageUrlChange: (value: string) => void;
  avatarFile?: File | null;
  onAvatarFileChange?: (file: File | null) => void;
  avatarSeed?: string;
  /**
   * The hatchling the bot wears without a picture, with onFaceChange: the
   * editor offers all eight while no picture is set. Octo's editor has none.
   */
  face?: Hatchling | null;
  onFaceChange?: (face: Hatchling) => void;
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
  handleRequired = false,
  connectionHint,
  handlePlaceholder,
  handleHelpText,
  displayName,
  onDisplayNameChange,
  avatarImageUrl,
  onAvatarImageUrlChange,
  avatarFile = null,
  onAvatarFileChange,
  avatarSeed,
  face = null,
  onFaceChange,
  dirty = true,
  bio = "",
  onBioChange,
  description,
  onDescriptionChange,
  onClose,
  onSave,
  saveLabel,
}: AgentProfileModalProps) {
  const isDesktop = useBreakpoint("sm", { freeze: isOpen });
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
  // The picture being chosen, else the saved one; with neither, AgentAvatar
  // shows the bot's own face: the hatchling picked below, or Octo's tile.
  const avatarPreviewSrc = previewUrl ?? normalizeCustomAgentAvatarSrc(avatarImageUrl);
  const hasPicture = Boolean(avatarImageUrl || avatarFile);
  const previewSeed = face && !hasPicture ? hatchlingSeed(face) : avatarSeed;
  // Removing a picture takes its button away with it. Focus then goes on to
  // what the bot wears now, its face below (for Octo, its picture button),
  // rather than back to the top of the dialog.
  const photoButtonRef = useRef<HTMLButtonElement>(null);
  const facePickerRef = useRef<HTMLFieldSetElement>(null);
  const pictureRemovedRef = useRef(false);
  useLayoutEffect(() => {
    if (!pictureRemovedRef.current || hasPicture) return;
    pictureRemovedRef.current = false;
    (facePickerRef.current?.querySelector<HTMLInputElement>("input:checked") ?? photoButtonRef.current)?.focus();
  }, [hasPicture]);

  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onClose();
  };
  const actions = <SettingsFormActions saveLabel={effectiveSaveLabel} saving={pending}
    disabled={!dirty || (handleRequired && !handle.trim()) || Array.from(bio).length > PROFILE_BIO_MAX_LENGTH}
    onSave={onSave} onCancel={onClose} saveTestId="agent-profile-save" />;
  const form = (
      <StudioDialogBody scrollable={isDesktop}>
        <SettingsFormLayout>
          <SettingsIdentityRow>
            {/* A bot is an AI, so its photo target is the AI tile, never a
                person's circle. */}
            <IdentityPhotoButton
              buttonRef={photoButtonRef}
              shape="aiTile"
              label={hasPicture ? "Change bot picture" : "Upload bot picture"}
              accept={IDENTITY_IMAGE_ACCEPT}
              disabled={pending || !onAvatarFileChange}
              inputTestId="agent-profile-picture-input"
              onSelect={(file) => {
                const error = validateIdentityImage(file);
                setPhotoError(error);
                if (!error) onAvatarFileChange?.(file);
              }}
            >
              <AgentAvatar agent={{ handle, displayName, avatarSeed: previewSeed }} size="lg" imageSrc={avatarPreviewSrc} />
            </IdentityPhotoButton>
            <Field label="Display name" htmlFor="agent-profile-display-name">
              <Input id="agent-profile-display-name" value={displayName}
                onChange={(event) => onDisplayNameChange(event.target.value)} disabled={pending}
                data-testid="agent-profile-display-name-input" />
            </Field>
          </SettingsIdentityRow>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text as="p" variant="caption" tone="muted">PNG, JPEG or WebP, up to 2 MB.</Text>
            {hasPicture ? <Button variant="ghost" size="md" radius="xl" isDisabled={pending}
              onPress={() => {
                pictureRemovedRef.current = true;
                onAvatarFileChange?.(null);
                onAvatarImageUrlChange("");
                setPhotoError(null);
              }}>
              Remove picture
            </Button> : null}
          </div>
          {photoError ? <Text as="p" role="alert" variant="caption" tone="danger">{photoError}</Text> : null}
          {/* A picture is the bot's face; without one it wears the hatchling
              chosen here (docs/Brand.md, "Octo's hatchlings"). */}
          {face && onFaceChange && !hasPicture
            ? <AgentFacePicker ref={facePickerRef} value={face} onChange={onFaceChange} disabled={pending} />
            : null}
          <Field label="Handle" htmlFor="agent-profile-handle" hint={handleHelpText || undefined}>
            <Input
              id="agent-profile-handle"
              value={handle}
              onChange={(event) => onHandleChange(event.target.value)}
              placeholder={handlePlaceholder ?? "@bob"}
              radius="xl"
              disabled={pending || handleDisabled}
              required={handleRequired}
              data-testid="agent-profile-handle-input"
            />
          </Field>

          {onBioChange ? <ProfileBioField id="agent-profile-bio" value={bio} onChange={onBioChange} disabled={pending} isAgent /> : null}

          <section className="space-y-4 border-t border-slate-200/70 pt-5 dark:border-[color:var(--color-studio-dark-divider)]" aria-label="Bot behavior">
            <div>
              <Text as="h3" variant="bodyStrong" tone="primary">Bot behavior</Text>
              <Text as="p" variant="caption" tone="muted" className="mt-1">Connection, model and response preferences. These are separate from the public profile.</Text>
            </div>
            {connectionHint ? (
              <Field label="Connection">
                <Text as="p" variant="caption" tone="muted" data-testid="agent-profile-connection-hint">
                  {connectionHint}
                </Text>
              </Field>
            ) : null}
            {showProviderPicker && providerId ? (
              <Field label="Provider" labelId="agent-profile-provider-label" htmlFor="agent-profile-provider">
                <ProviderMenuSelect
                  id="agent-profile-provider"
                  ariaLabelledBy="agent-profile-provider-label"
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
              <Field label="Credential" labelId="agent-profile-credential-label" htmlFor="agent-profile-credential">
                <CredentialMenuSelect
                  id="agent-profile-credential"
                  ariaLabelledBy="agent-profile-credential-label"
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
              <Field label="Model" labelId="agent-profile-model-label" htmlFor={isDesktop ? "agent-profile-model" : undefined}>
                <ModelMenuSelect
                  id="agent-profile-model"
                  ariaLabelledBy="agent-profile-model-label"
                  presentation={isDesktop ? "menu" : "inline"}
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
              <Text variant="caption" tone="muted" className="mt-1">
                Used as style guidance; it does not override core system instructions.
              </Text>
            </Field>
          </section>
        </SettingsFormLayout>
      </StudioDialogBody>
  );

  if (!isDesktop) {
    return <MobileFocusDialog isOpen={isOpen} onOpenChange={onOpenChange}
      dialogAriaLabel={title} closeDisabled={pending} dismissLabel="Close"
      gutter="responsive"
      data-testid="agent-profile-modal"
      footer={<AgentProfileFooter>{actions}</AgentProfileFooter>}
      header={<div>
        <Text as="h2" variant="subtitle" tone="primary">{title}</Text>
        {subtitle ? <Text as="p" variant="caption" tone="muted">{subtitle}</Text> : null}
      </div>}
    >
      {form}
    </MobileFocusDialog>;
  }

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
      dialogAriaLabel={title}
      layout="editor"
      gutter="responsive"
      data-testid="agent-profile-modal"
    >
      <StudioDialogHeader
        title={title}
        description={subtitle}
        onClose={onClose}
        closeButtonDisabled={pending}
        closeLabel="Close"
      />
      {form}
      <AgentProfileFooter>{actions}</AgentProfileFooter>
    </StudioDialogModal>
  );
}
