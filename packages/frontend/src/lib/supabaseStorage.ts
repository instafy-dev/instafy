import { uploadIdentityImage } from "./identityImages";
import { supabase } from "./supabaseClient";

interface UploadSiteAssetOptions {
  userId: string;
  fileName: string;
  file: File;
}

export async function uploadSiteAsset(options: UploadSiteAssetOptions): Promise<string> {
  const { userId, fileName, file } = options;
  const bucket = "site-assets";
  const path = `${userId}/${Date.now()}-${fileName}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false
  });
  if (error) {
    throw error;
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

interface UploadOrgAvatarOptions {
  orgId: string;
  file: File;
}

/** Team avatar upload; returns the public URL to store on the organization. */
export async function uploadOrgAvatar({ orgId, file }: UploadOrgAvatarOptions): Promise<string> {
  return uploadIdentityImage("orgs", orgId, file);
}
