import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase, hasSupabaseConfig } from "../lib/supabaseClient";
import type { RunRecord, RunType } from "../types";

interface RunSubscriptionOptions {
  projectId?: string;
  sessionId?: string;
  onRun: (run: RunRecord, event: "INSERT" | "UPDATE") => void;
  onDelete?: (runId: string) => void;
}

interface FetchRunsOptions {
  projectId?: string;
  sessionId?: string;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseRealtimeSupported =
  typeof window !== "undefined" &&
  hasSupabaseConfig &&
  SUPABASE_URL !== undefined &&
  !SUPABASE_URL.startsWith("http://127.0.0.1");

function coerceString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

export function mapRunRow(row: Record<string, unknown>): RunRecord {
  const rawRunType = coerceString(row.run_type);
  const runType = (rawRunType === "prompt" || rawRunType === "editor" || rawRunType === "build"
    ? rawRunType
    : "build") as RunType;
  return {
    id: coerceString(row.id) ?? "",
    projectId: coerceString(row.project_id),
    sessionId: coerceString(row.session_id),
    conversationId: coerceString(row.conversation_id),
    promptId: coerceString(row.prompt_id),
    runType,
    status: (coerceString(row.status) ?? "queued") as RunRecord["status"],
    progress: typeof row.progress === "number" ? row.progress : Number(row.progress ?? 0) || 0,
    progressStage: coerceString(row.progress_stage),
    previewUrl: coerceString(row.preview_url),
    lastMessage: coerceString(row.last_message),
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    createdAt: coerceString(row.created_at),
    updatedAt: coerceString(row.updated_at)
  };
}

export async function fetchRuns(options: FetchRunsOptions): Promise<RunRecord[]> {
  if (!supabaseRealtimeSupported) {
    return [];
  }

  const field = options.projectId ? "project_id" : options.sessionId ? "session_id" : null;
  const value = options.projectId ?? options.sessionId;

  if (!field || !value) {
    return [];
  }

  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .eq(field, value)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("fetchRuns: failed to load runs", error.message);
    return [];
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  return rows.map((row) => mapRunRow(row));
}

function handleChange(
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
  handlers: RunSubscriptionOptions
) {
  if (payload.eventType === "DELETE" && payload.old) {
    handlers.onDelete?.(coerceString(payload.old.id) ?? "");
    return;
  }

  if (!payload.new) {
    return;
  }

  const run = mapRunRow(payload.new as Record<string, unknown>);
  handlers.onRun(run, payload.eventType as "INSERT" | "UPDATE");
}

export function subscribeToRuns(options: RunSubscriptionOptions): () => void {
  if (!supabaseRealtimeSupported) {
    return () => {};
  }

  const field = options.projectId ? "project_id" : options.sessionId ? "session_id" : null;
  const value = options.projectId ?? options.sessionId;
  if (!field || !value) {
    return () => {};
  }

  const channelName = `runs:${field}:${value}`;
  const channel: RealtimeChannel = supabase.channel(channelName);

  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "runs",
      filter: `${field}=eq.${value}`
    },
    (payload) => handleChange(payload, options)
  );

  channel.subscribe((status) => {
    if (status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
      console.warn(`subscribeToRuns: realtime channel ${channelName} ${status.toLowerCase()}`);
    }
  });

  return () => {
    channel.unsubscribe().catch((error) => {
      console.warn("subscribeToRuns: failed to unsubscribe", error);
    });
  };
}

export const runsRealtimeEnabled = supabaseRealtimeSupported;
