import { IdentityPhotoButton } from "../../../components/IdentityPhotoButton";
import { IDENTITY_IMAGE_ACCEPT } from "../../../lib/identityImages";
import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { OrgIdentity } from "../../../components/OrgIdentity";
import {
  updateControllerOrganization,
} from "../../../services/runtimeController/projects";
import { useStatus } from "../../../status/useStatus";

import { notifyTeamProfileUpdated, saveTeamAvatar, validateTeamAvatar } from "./teamAvatar";

/**
 * Team avatar (pfp) editor for org settings. The image shows on the sidebar
 * team rail and the workspace switcher; initials remain the fallback.
 */
export function OrgAvatarEditor({
  orgId,
  orgName,
  accentColor,
  canEdit,
  avatarUrl: initialAvatarUrl,
}: {
  orgId: string;
  orgName: string;
  accentColor?: string | null;
  canEdit: boolean;
  avatarUrl: string | null;
}) {
  const { showStatus } = useStatus();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatarUrl);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setAvatarUrl(initialAvatarUrl);
  }, [initialAvatarUrl, orgId]);

  const handleFileChosen = async (file: File) => {
    if (!canEdit || pending) return;
    const invalid = validateTeamAvatar(file);
    if (invalid) {
      showStatus(invalid, "error", 4000);
      return;
    }
    setPending(true);
    try {
      const publicUrl = await saveTeamAvatar(orgId, file);
      setAvatarUrl(publicUrl);
      showStatus("Team picture updated.", "success", 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Couldn't update the team picture: ${message}`, "error", 5000);
    } finally {
      setPending(false);
    }
  };

  const handleRemove = async () => {
    if (!canEdit || pending) return;
    setPending(true);
    try {
      if (!await updateControllerOrganization(orgId, { avatarUrl: "" })) {
        throw new Error("Team picture could not be removed. Try again.");
      }
      notifyTeamProfileUpdated();
      setAvatarUrl(null);
      showStatus("Team picture removed.", "success", 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Couldn't remove the team picture: ${message}`, "error", 5000);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="org-avatar-editor">
      {canEdit ? <IdentityPhotoButton square disabled={pending} accept={IDENTITY_IMAGE_ACCEPT}
        label={pending ? "Saving team picture" : avatarUrl ? "Change team picture" : "Upload team picture"}
        onSelect={file => void handleFileChosen(file)} testId="org-avatar-change" inputTestId="org-avatar-file-input">
        <span data-testid="org-avatar-preview"><OrgIdentity name={orgName} avatarUrl={avatarUrl} accentColor={accentColor} className="h-16 w-16 text-base" /></span>
      </IdentityPhotoButton> : <span data-testid="org-avatar-preview"><OrgIdentity name={orgName} avatarUrl={avatarUrl} accentColor={accentColor} className="h-16 w-16 text-base" /></span>}
      {canEdit ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
          {avatarUrl ? (
            <Button
              variant="ghost"
              size="xs"
              radius="lg"
              isDisabled={pending}
              data-testid="org-avatar-remove"
              onPress={() => void handleRemove()}
            >
              Remove
            </Button>
          ) : null}
          </div>
          <Text variant="caption" tone="muted">PNG, JPEG or WebP, up to 2 MB.</Text>
        </div>
      ) : (
        <Text variant="caption" tone="muted">
          Shown wherever this team appears.
        </Text>
      )}
    </div>
  );
}
