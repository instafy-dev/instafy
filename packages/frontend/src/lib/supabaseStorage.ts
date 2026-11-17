import { uploadIdentityImage } from "./identityImages";

interface UploadOrgAvatarOptions {
  orgId: string;
  file: File;
}

/** Team avatar upload; returns the public URL to store on the organization. */
export async function uploadOrgAvatar({ orgId, file }: UploadOrgAvatarOptions): Promise<string> {
  return uploadIdentityImage("orgs", orgId, file);
}
