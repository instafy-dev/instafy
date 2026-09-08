import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { getOrgInitials } from "../../../org/orgNaming";
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
  canEdit,
  avatarUrl: initialAvatarUrl,
}: {
  orgId: string;
  orgName: string;
  canEdit: boolean;
  avatarUrl: string | null;
}) {
  const { showStatus } = useStatus();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
      <span
        className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-200/80 text-sm font-semibold text-slate-600 dark:bg-white/[0.08] dark:text-slate-300"
        data-testid="org-avatar-preview"
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt={`${orgName} avatar`} className="h-12 w-12 object-cover" />
        ) : (
          getOrgInitials(orgName)
        )}
      </span>
      {canEdit ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            disabled={pending}
            data-testid="org-avatar-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                void handleFileChosen(file);
              }
            }}
          />
          <Button
            variant="outline"
            size="xs"
            radius="full"
            isDisabled={pending}
            data-testid="org-avatar-change"
            onPress={() => fileInputRef.current?.click()}
          >
            {pending ? "Saving…" : avatarUrl ? "Change picture" : "Add picture"}
          </Button>
          {avatarUrl ? (
            <Button
              variant="ghost"
              size="xs"
              radius="full"
              isDisabled={pending}
              data-testid="org-avatar-remove"
              onPress={() => void handleRemove()}
            >
              Remove
            </Button>
          ) : null}
          </div>
          <Text variant="caption" tone="muted">Images up to 2 MB. Shown in the team list.</Text>
        </div>
      ) : (
        <Text variant="caption" tone="muted">
          Shown in the team list.
        </Text>
      )}
    </div>
  );
}
