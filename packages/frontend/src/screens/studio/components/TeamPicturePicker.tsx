import { IdentityPhotoButton } from "../../../components/IdentityPhotoButton";
import { IDENTITY_IMAGE_ACCEPT } from "../../../lib/identityImages";
import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { OrgIdentity } from "../../../components/OrgIdentity";
import { validateTeamAvatar } from "./teamAvatar";

export function TeamPicturePicker({
  name, file, accentColor, onChange, disabled = false, testId = "new-team-picture",
}: {
  name: string;
  accentColor?: string | null;
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div className="space-y-2" data-testid={testId}>
      <Text variant="caption" tone="muted">Team picture (optional)</Text>
      <div className="flex flex-wrap items-center gap-3">
        <IdentityPhotoButton square label={file ? "Change team picture" : "Upload team picture"}
          accept={IDENTITY_IMAGE_ACCEPT} disabled={disabled} inputTestId={`${testId}-input`}
          onSelect={next => {
            const invalid = validateTeamAvatar(next); setError(invalid);
            if (!invalid) onChange(next);
          }}>
          <OrgIdentity name={name} avatarUrl={preview} accentColor={accentColor} className="h-16 w-16 text-base" />
        </IdentityPhotoButton>
        {file ? <Button type="button" variant="ghost" size="xs" isDisabled={disabled}
          onPress={() => { onChange(null); setError(null); }}>Remove</Button> : null}
      </div>
      <Text variant="caption" tone="muted">PNG, JPEG or WebP, up to 2 MB. You can change this later in Team profile.</Text>
      {error ? <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}
    </div>
  );
}
