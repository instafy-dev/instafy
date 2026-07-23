export function formatAuthRequiredError(params?: {
  retryCommand?: string;
  advancedHint?: string;
}): Error {
  const lines = ["Sign in to Instafy to continue.", "", "Run: instafy login"];
  if (params?.retryCommand && params.retryCommand !== "instafy login") {
    lines.push("", `Then retry: ${params.retryCommand}`);
  }
  if (params?.advancedHint) {
    lines.push("", `For automation: ${params.advancedHint}`);
  }
  return new Error(lines.join("\n"));
}

export function extractControllerErrorMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message.trim() : "";
      if (message) return message;
      const error = typeof record.error === "string" ? record.error.trim() : "";
      if (error) return error;
      const hint = typeof record.hint === "string" ? record.hint.trim() : "";
      if (hint) return hint;
    }
  } catch {
    // ignore malformed json
  }

  return trimmed;
}

export function formatAuthRejectedError(params?: {
  status?: number;
  responseBody?: string;
  retryCommand?: string;
  advancedHint?: string;
}): Error {
  const status = params?.status ?? 0;
  const message = params?.responseBody ? extractControllerErrorMessage(params.responseBody) : null;
  const normalized = (message ?? "").toLowerCase();
  const isRoutineAuthMessage =
    normalized === "user session required" ||
    normalized === "authentication required" ||
    normalized === "authorization header must be bearer token" ||
    normalized === "authorization token is empty";

  const headline = (() => {
    if (status === 403) {
      return "Access denied. Sign in with an account that can use this space.";
    }
    if (status === 401 && normalized.includes("expired")) {
      return "Your Instafy sign-in expired.";
    }
    if (status === 401) {
      return "Sign in to Instafy to continue.";
    }
    return "Sign in to Instafy to continue.";
  })();

  const lines = [headline];
  lines.push("", "Run: instafy login");
  if (params?.retryCommand && params.retryCommand !== "instafy login") {
    lines.push("", `Then retry: ${params.retryCommand}`);
  }
  if (message && !isRoutineAuthMessage) {
    lines.push("", `Server: ${message}`);
  }
  if (params?.advancedHint) {
    lines.push("", `For automation: ${params.advancedHint}`);
  }
  return new Error(lines.join("\n"));
}
