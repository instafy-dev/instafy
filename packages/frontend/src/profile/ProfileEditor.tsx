import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { EditPencil } from "iconoir-react";
import { Button } from "../components/Button";
import { SettingsFormLayout } from "../components/SettingsFormLayout";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const handleFileUpload = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
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
    if (bioTooLong) return;
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
  }, [avatarUrl, bio, bioTooLong, displayName, onDone, showStatus, updateProfile, user]);

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
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            aria-label="Choose profile photo"
            onChange={handleFileUpload}
            disabled={profileUnavailable || saving}
            className="hidden"
          />
          <Button
            onPress={() => fileInputRef.current?.click()}
            aria-label={avatarPreview ? "Change profile photo" : "Upload profile photo"}
            title={avatarPreview ? "Change profile photo" : "Upload profile photo"}
            isDisabled={profileUnavailable || saving}
            variant="ghost"
            size="icon"
            radius="full"
            className="group relative h-16 w-16 shrink-0"
          >
            <HumanAvatar
              userId={user?.id}
              displayName={displayName}
              avatarUrl={avatarPreview}
              photoAlt="Profile photo preview"
              className="h-16 w-16 text-base"
              data-testid="profile-avatar-preview"
            />
            <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm group-hover:bg-slate-50 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-100 dark:group-hover:bg-[var(--color-studio-dark-control-hover)]">
              <EditPencil className="h-3.5 w-3.5" />
            </span>
          </Button>
          <Field label="Display name" htmlFor="profile-display-name" className="min-w-0">
            <Input
              id="profile-display-name"
              type="text"
              disabled={profileUnavailable}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
        </div>
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
        <ProfileBioField id="profile-bio" value={bio} onChange={setBio} disabled={profileUnavailable} />
        <div className="flex flex-col gap-3 border-t border-slate-200/70 pt-3 dark:border-[color:var(--color-studio-dark-divider)] @min-[32rem]/profile-editor:flex-row @min-[32rem]/profile-editor:items-center @min-[32rem]/profile-editor:justify-between">
          <Text as="p" variant="caption" tone="muted">
            {loading ? "Loading profile…" : "Visible to teammates who share a space with you."}
          </Text>
          <Button
            onPress={handleSave}
            isDisabled={!hasChanges || saving || profileUnavailable || bioTooLong}
            variant="primary"
            size="sm"
            radius="xl"
            className="min-h-11 w-full shrink-0 sm:pointer-fine:min-h-9 @min-[32rem]/profile-editor:w-auto"
          >
            {saving ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </div>
    </SettingsFormLayout>
  );
}
