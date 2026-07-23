import type { SiteBuilderState } from "../types";
import { supabase, hasSupabaseConfig } from "./supabaseClient";

export async function upsertSite(state: SiteBuilderState & { userId: string; projectId: string }) {
  if (!hasSupabaseConfig) {
    return;
  }
  const { userId, projectId, ...rest } = state;
  const payload = {
    user_id: userId,
    project_id: projectId,
    metadata: rest.metadata,
    content: rest.content,
    deployment: rest.deployment
  };

  const { error } = await supabase.from("sites").upsert(payload, { onConflict: "project_id" });
  if (error) {
    throw error;
  }
}

export async function fetchSite(userId: string) {
  if (!hasSupabaseConfig) {
    return null;
  }

  const { data, error } = await supabase
    .from("sites")
    .select("metadata, content, deployment, project_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}
