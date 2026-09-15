import { uploadOrgAvatar } from "../../../lib/supabaseStorage";
import { updateControllerOrganization } from "../../../services/runtimeController/projects";

export function validateTeamAvatar(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Team picture must be an image file.";
  if (file.size > 2 * 1024 * 1024) return "Team picture must be 2 MB or smaller.";
  return null;
}

export function notifyTeamProfileUpdated() {
  window.dispatchEvent(new CustomEvent("instafy:orgs-updated"));
}

export async function saveTeamAvatar(orgId: string, file: File): Promise<string> {
  const invalid = validateTeamAvatar(file);
  if (invalid) throw new Error(invalid);
  const avatarUrl = await uploadOrgAvatar({ orgId, file });
  if (!await updateControllerOrganization(orgId, { avatarUrl })) {
    throw new Error("Team picture could not be saved. Check your connection and try again.");
  }
  notifyTeamProfileUpdated();
  return avatarUrl;
}
