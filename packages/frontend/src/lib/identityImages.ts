import { supabase } from "./supabaseClient";

export const IDENTITY_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function validateIdentityImage(file: File): string | null {
  if (!EXTENSIONS[file.type]) return "Choose a PNG, JPEG or WebP image.";
  if (file.size > 2 * 1024 * 1024) return "Picture must be 2 MB or smaller.";
  if (!file.size) return "Choose an image that isn't empty.";
  return null;
}

/** User-authenticated upload. Agent paths use the owner user ID; other paths use the identity ID. */
export async function uploadIdentityImage(kind: "orgs" | "spaces" | "agents", id: string, file: File): Promise<string> {
  const invalid = validateIdentityImage(file);
  if (invalid) throw new Error(invalid);
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new Error("Invalid picture destination.");
  const path = `${kind}/${id.toLowerCase()}/${crypto.randomUUID()}.${EXTENSIONS[file.type]}`;
  const bucket = supabase.storage.from("identity-images");
  const { error } = await bucket.upload(path, file, { cacheControl: "31536000", upsert: false, contentType: file.type });
  if (error) throw new Error(`Unable to upload picture: ${error.message}`);
  return bucket.getPublicUrl(path).data.publicUrl;
}
