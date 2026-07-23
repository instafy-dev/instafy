import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { uploadOrgAvatar } from "../../../lib/supabaseStorage";
import { getOrgInitials } from "../../../org/orgNaming";
import {
  listControllerOrganizations,
  updateControllerOrganization,
} from "../../../services/runtimeController/projects";
import { useStatus } from "../../../status/useStatus";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Team avatar (pfp) editor for org settings. The image shows on the sidebar
 * team rail and the workspace switcher; initials remain the fallback.
 */
export function OrgAvatarEditor({
  orgId,
  orgName,
  canEdit,
}: {
  orgId: string;
  orgName: string;
  canEdit: boolean;
}) {
  const { showStatus } = useStatus();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listControllerOrganizations()
      .then((orgs) => {
        if (cancelled) {
          return;
        }
        const match = orgs.find((org) => org.id === orgId);
        setAvatarUrl(match?.avatarUrl ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const notifyOrgsUpdated = () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("instafy:orgs-updated"));
    }
  };

  const handleFileChosen = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      showStatus("Team picture must be an image file.", "error", 4000);
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      showStatus("Team picture must be 2 MB or smaller.", "error", 4000);
      return;
    }
    setPending(true);
    try {
      const publicUrl = await uploadOrgAvatar({ orgId, file });
      await updateControllerOrganization(orgId, { avatarUrl: publicUrl });
      setAvatarUrl(publicUrl);
      notifyOrgsUpdated();
      showStatus("Team picture updated.", "success", 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Couldn't update the team picture: ${message}`, "error", 5000);
    } finally {
      setPending(false);
    }
  };

  const handleRemove = async () => {
    setPending(true);
    try {
      await updateControllerOrganization(orgId, { avatarUrl: "" });
      setAvatarUrl(null);
      notifyOrgsUpdated();
      showStatus("Team picture removed.", "success", 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Couldn't remove the team picture: ${message}`, "error", 5000);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-3" data-testid="org-avatar-editor">
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
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
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
      ) : (
        <Text variant="caption" tone="muted">
          Team picture — shown in the sidebar. Owners and admins can change it.
        </Text>
      )}
    </div>
  );
}
