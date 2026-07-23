export type PersonalBrowserToolEventProof = {
  hasCommandExecution: boolean;
  hasCompletedPersonalBrowserMcp: boolean;
  hasFailedPersonalBrowserMcp: boolean;
  hasRuntimeUnavailableAlert: boolean;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parsePersonalBrowserToolEventProof(
  payload: unknown,
  jobId: string,
): PersonalBrowserToolEventProof | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  let hasCommandExecution = false;
  let hasCompletedPersonalBrowserMcp = false;
  let hasFailedPersonalBrowserMcp = false;
  let hasRuntimeUnavailableAlert = false;

  for (const value of payload) {
    const metadata = objectRecord(objectRecord(value)?.metadata);
    if (!metadata) {
      continue;
    }
    const details = objectRecord(metadata.details);
    if (
      metadata.kind === "runtime_alert" &&
      details?.reason === "runtime_unavailable"
    ) {
      hasRuntimeUnavailableAlert = true;
    }
    const messageJobId = metadata.jobId ?? metadata.job_id;
    if (messageJobId !== jobId) {
      continue;
    }
    const messageType = String(metadata.messageType ?? metadata.message_type ?? "")
      .trim()
      .toLowerCase();
    if (messageType === "command_execution") {
      hasCommandExecution = true;
    }
    if (
      messageType === "mcp_tool_call" &&
      details?.server === "instafy_personal_browser"
    ) {
      const status = String(details.status ?? "").trim().toLowerCase();
      if (status === "completed") {
        hasCompletedPersonalBrowserMcp = true;
      } else if (status === "failed") {
        hasFailedPersonalBrowserMcp = true;
      }
    }
  }

  return {
    hasCommandExecution,
    hasCompletedPersonalBrowserMcp,
    hasFailedPersonalBrowserMcp,
    hasRuntimeUnavailableAlert,
  };
}
