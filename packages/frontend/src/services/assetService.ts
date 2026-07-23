import { uploadSiteAsset } from "../lib/supabaseStorage";

export async function uploadImage(userId: string, file: File, label: string) {
  const url = await uploadSiteAsset({
    userId,
    fileName: `${label}-${file.name}`,
    file
  });
  return url;
}
