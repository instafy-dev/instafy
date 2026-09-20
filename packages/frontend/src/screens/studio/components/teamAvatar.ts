import { validateIdentityImage } from "../../../lib/identityImages";
import { uploadOrgAvatar } from "../../../lib/supabaseStorage";
import { updateControllerOrganization } from "../../../services/runtimeController/projects";

export function validateTeamAvatar(file: File): string | null {
  return validateIdentityImage(file);
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
