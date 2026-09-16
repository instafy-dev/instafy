import { useCallback, useEffect, useState } from "react";
import { IdentityPhotoButton } from "../components/IdentityPhotoButton";
import { Button } from "../components/Button";
import { SettingsFormLayout, SettingsIdentityRow } from "../components/SettingsFormLayout";
import { SettingsFormActions } from "../components/SettingsFormActions";
import { Field } from "../components/Field";
import { Input } from "../components/Input";
import { PROFILE_BIO_MAX_LENGTH } from "@instafy/sdk/human-profiles";
import { ProfileBioField } from "../components/ProfileBioField";
import { HumanAvatar } from "../components/HumanAvatar";
import { Text } from "../components/Text";
import { useAuth } from "../providers/AuthProvider";
import { useStatus } from "../status/useStatus";
import { useProfile } from "./ProfileProvider";

interface ProfileEditorProps {
  variant?: "panel" | "menu";
  onDone?: () => void;
}

export function ProfileEditor({ variant = "panel", onDone }: ProfileEditorProps) {
  const { user } = useAuth();
  const { profile, updateProfile, loading, error, refresh } = useProfile();
  const { showStatus } = useStatus();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(profile?.fullName ?? "");
    setAvatarUrl(profile?.avatarUrl ?? "");
    setBio(profile?.bio ?? "");
  }, [profile?.avatarUrl, profile?.fullName, profile?.bio]);

  const avatarPreview = avatarUrl.trim() || null;
  const hasChanges =
    displayName.trim() !== (profile?.fullName ?? "") ||
    avatarUrl.trim() !== (profile?.avatarUrl ?? "") ||
    bio.trim() !== (profile?.bio ?? "");
  const bioTooLong = Array.from(bio).length > PROFILE_BIO_MAX_LENGTH;
  const compact = variant === "menu";
  const profileUnavailable = loading || (!profile && Boolean(error));

  const handleFileUpload = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setUploadError("Choose an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (result) {
        setAvatarUrl(result);
        setUploadError(null);
      } else {
        setUploadError("Unable to read image.");
      }
    };
    reader.onerror = () => {
      setUploadError("Unable to read image.");
    };
    reader.readAsDataURL(file);
  }, []);

  const handleSave = useCallback(async () => {
    if (!user) {
      showStatus("Sign in to update your profile.", "error", 3500);
      return;
    }
    if (bioTooLong || saving || profileUnavailable || !hasChanges) return;
    const trimmedName = displayName.trim();
    const trimmedAvatar = avatarUrl.trim();
    setSaving(true);
    const result = await updateProfile({
      fullName: trimmedName.length > 0 ? trimmedName : null,
      avatarUrl: trimmedAvatar.length > 0 ? trimmedAvatar : null,
      bio: bio.trim() || null
    });
    if (!result.success) {
      showStatus(result.error ?? "Unable to update profile.", "error", 4000);
    } else {
      showStatus("Profile updated.", "success", 2500);
      onDone?.();
    }
    setSaving(false);
  }, [avatarUrl, bio, bioTooLong, displayName, hasChanges, onDone, profileUnavailable, saving, showStatus, updateProfile, user]);

  return (
    <SettingsFormLayout className="@container/profile-editor" data-testid="profile-editor">
      {!compact ? (
        <div>
          <Text as="h3" variant="bodyStrong" tone="primary">
            Profile
          </Text>
          <Text variant="caption" tone="muted" className="mt-1">
            Introduce yourself to teammates with a name, photo, and short bio.
          </Text>
        </div>
      ) : null}
      {error ? (
        <div className="space-y-2">
          <Text as="p" role="alert" variant="caption" tone="danger">{error}</Text>
          <Button variant="outline" size="sm" radius="xl" onPress={() => { void refresh({ force: true }); }}>
            Retry loading profile
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-4">
        <SettingsIdentityRow>
          <IdentityPhotoButton label={avatarPreview ? "Change profile photo" : "Upload profile photo"}
            disabled={profileUnavailable || saving} onSelect={handleFileUpload}>
            <HumanAvatar
              userId={user?.id}
              displayName={displayName}
              avatarUrl={avatarPreview}
              photoAlt="Profile photo preview"
              className="h-16 w-16 text-base"
              data-testid="profile-avatar-preview"
            />
          </IdentityPhotoButton>
          <Field label="Display name" htmlFor="profile-display-name" className="min-w-0">
            <Input
              id="profile-display-name"
              type="text"
              disabled={profileUnavailable || saving}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
        </SettingsIdentityRow>
        {avatarPreview ? (
          <Button
            onPress={() => {
              setAvatarUrl("");
              setUploadError(null);
            }}
            isDisabled={profileUnavailable || saving}
            variant="ghost"
            size="sm"
            radius="xl"
            className="self-start"
          >
            Remove photo
          </Button>
        ) : null}
        {uploadError ? (
          <Text as="p" role="alert" variant="caption" tone="danger" className="font-medium">
            {uploadError}
          </Text>
        ) : null}
        <ProfileBioField id="profile-bio" value={bio} onChange={setBio} disabled={profileUnavailable || saving} />
        <SettingsFormActions saveLabel="Save profile" onSave={() => void handleSave()}
          saving={saving} disabled={!hasChanges || profileUnavailable || bioTooLong}
          cancelDisabled={!hasChanges || profileUnavailable} onCancel={() => {
            setDisplayName(profile?.fullName ?? ""); setAvatarUrl(profile?.avatarUrl ?? "");
            setBio(profile?.bio ?? ""); setUploadError(null);
          }} hint={loading ? "Loading profile…" : "Visible to teammates who share a space with you."} />
      </div>
    </SettingsFormLayout>
  );
}
