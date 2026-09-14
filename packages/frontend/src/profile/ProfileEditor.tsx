import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Camera, Trash } from "iconoir-react";
import { Button } from "../components/Button";
import { SettingsFormLayout } from "../components/SettingsFormLayout";
import { Field } from "../components/Field";
import { Input } from "../components/Input";
import { Text } from "../components/Text";
import { useAuth } from "../providers/AuthProvider";
import { useStatus } from "../status/useStatus";
import { useProfile } from "./ProfileProvider";

interface ProfileEditorProps {
  variant?: "panel" | "menu";
  onDone?: () => void;
}

function resolveInitials(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "U";
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return parts[0].slice(0, 2).toUpperCase();
}

export function ProfileEditor({ variant = "panel", onDone }: ProfileEditorProps) {
  const { user } = useAuth();
  const { profile, updateProfile, loading } = useProfile();
  const { showStatus } = useStatus();
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [showImageUrl, setShowImageUrl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDisplayName(profile?.fullName ?? "");
    setAvatarUrl(profile?.avatarUrl ?? "");
  }, [profile?.avatarUrl, profile?.fullName]);

  const baseName = displayName.trim() || user?.email || "";
  const initials = useMemo(() => resolveInitials(baseName), [baseName]);
  const avatarPreview = avatarUrl.trim() || null;
  const hasChanges =
    displayName.trim() !== (profile?.fullName ?? "") ||
    avatarUrl.trim() !== (profile?.avatarUrl ?? "");
  const compact = variant === "menu";

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
        setShowImageUrl(false);
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
    const trimmedName = displayName.trim();
    const trimmedAvatar = avatarUrl.trim();
    setSaving(true);
    const result = await updateProfile({
      fullName: trimmedName.length > 0 ? trimmedName : null,
      avatarUrl: trimmedAvatar.length > 0 ? trimmedAvatar : null
    });
    if (!result.success) {
      showStatus(result.error ?? "Unable to update profile.", "error", 4000);
    } else {
      showStatus("Profile updated.", "success", 2500);
      onDone?.();
    }
    setSaving(false);
  }, [avatarUrl, displayName, onDone, showStatus, updateProfile, user]);

  return (
    <SettingsFormLayout className="@container/profile-editor" data-testid="profile-editor">
      {!compact ? (
        <div>
          <Text as="h3" variant="bodyStrong" tone="primary">
            Profile
          </Text>
          <Text variant="caption" tone="muted" className="mt-1">
            Your name and photo appear to teammates across the studio.
          </Text>
        </div>
      ) : null}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-50 text-base font-semibold text-slate-700 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-100">
            {avatarPreview ? (
              <img src={avatarPreview} alt="Profile photo preview" className="h-full w-full object-cover" />
            ) : (
              initials
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              aria-label="Choose profile photo"
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              onPress={() => fileInputRef.current?.click()}
              variant="outline"
              size="sm"
              radius="full"
              className="gap-2"
            >
              <Camera className="text-base" aria-hidden="true" />
              {avatarPreview ? "Change photo" : "Upload photo"}
            </Button>
            {avatarPreview ? (
              <Button
                onPress={() => {
                  setAvatarUrl("");
                  setUploadError(null);
                }}
                variant="ghost"
                size="sm"
                radius="full"
                className="gap-2"
              >
                <Trash className="text-base" aria-hidden="true" />
                Remove photo
              </Button>
            ) : null}
          </div>
        </div>
        {uploadError ? (
          <Text as="p" role="alert" variant="caption" tone="danger" className="font-medium">
            {uploadError}
          </Text>
        ) : null}
        <div className="space-y-2">
          <Button
            onPress={() => setShowImageUrl((visible) => !visible)}
            aria-expanded={showImageUrl}
            aria-controls="profile-image-url-field"
            variant="ghost"
            size="sm"
            radius="lg"
          >
            {showImageUrl ? "Hide image URL" : "Use image URL"}
          </Button>
          {showImageUrl ? (
            <div id="profile-image-url-field">
              <Field label="Image URL" htmlFor="profile-avatar-url" hint="Paste an image link to replace your photo.">
                <Input
                  id="profile-avatar-url"
                  type="url"
                  value={avatarUrl.trim().startsWith("data:") ? "" : avatarUrl}
                  onChange={(event) => {
                    setAvatarUrl(event.target.value);
                    setUploadError(null);
                  }}
                  placeholder="https://"
                />
              </Field>
            </div>
          ) : null}
        </div>
        <Field label="Display name" htmlFor="profile-display-name">
          <Input
            id="profile-display-name"
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Add your name"
          />
        </Field>
        <div className="flex flex-col gap-3 border-t border-slate-200/70 pt-3 dark:border-[color:var(--color-studio-dark-divider)] @min-[32rem]/profile-editor:flex-row @min-[32rem]/profile-editor:items-center @min-[32rem]/profile-editor:justify-between">
          <Text as="p" variant="caption" tone="muted">
            {loading ? "Loading profile…" : "Changes update your team member name too."}
          </Text>
          <Button
            onPress={handleSave}
            isDisabled={!hasChanges || saving}
            variant="primary"
            size="sm"
            radius="xl"
            className="w-full shrink-0 @min-[32rem]/profile-editor:w-auto"
          >
            {saving ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </div>
    </SettingsFormLayout>
  );
}
