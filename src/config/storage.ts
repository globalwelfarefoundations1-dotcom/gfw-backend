import { supabase } from "./supabase.js";

export const PROJECT_MEDIA_BUCKET = "project-media";

export async function uploadToStorage(path: string, buffer: Buffer, contentType: string) {
  const { error } = await supabase.storage
    .from(PROJECT_MEDIA_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });

  if (error) {
    throw new Error(`Failed to upload ${path}: ${error.message}`);
  }

  return path;
}

export async function removeFromStorage(paths: string[]) {
  if (paths.length === 0) return;

  const { error } = await supabase.storage.from(PROJECT_MEDIA_BUCKET).remove(paths);

  if (error) {
    throw new Error(`Failed to remove files: ${error.message}`);
  }
}

export function getPublicUrl(path: string): string {
  const { data } = supabase.storage.from(PROJECT_MEDIA_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
