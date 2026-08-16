export type RuntimeControllerCredential = {
  kind: "job" | "machine";
  token: string;
  controllerUrl: string;
};

function clean(value: string | undefined | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function validatedControllerOrigin(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error(`${label} must use http or https and must not contain credentials.`);
  }
  return parsed.origin;
}

export function resolveRuntimeControllerCredential(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeControllerCredential | null {
  if (!clean(env["RUNTIME_ID"])) {
    return null;
  }

  const conversationId =
    clean(env["INSTAFY_CONVERSATION_ID"]) ?? clean(env["CONVERSATION_ID"]);
  const leaseId = clean(env["RUNTIME_LEASE_ID"]);
  const kind = conversationId ? "job" : leaseId ? "machine" : null;
  if (!kind) {
    return null;
  }

  const token = clean(
    kind === "job" ? env["CONTROLLER_ACCESS_TOKEN"] : env["RUNTIME_ACCESS_TOKEN"],
  );
  if (!token) {
    throw new Error(
      kind === "job"
        ? "The active runtime job is missing its scoped controller credential (CONTROLLER_ACCESS_TOKEN)."
        : "The active runtime process is missing its scoped machine credential (RUNTIME_ACCESS_TOKEN).",
    );
  }

  const controllerUrl = clean(env["CONTROLLER_BASE_URL"]);
  if (!controllerUrl) {
    throw new Error(
      "The active runtime context is missing its controller URL binding (CONTROLLER_BASE_URL).",
    );
  }
  validatedControllerOrigin(controllerUrl, "CONTROLLER_BASE_URL");
  return { kind, token, controllerUrl };
}

export function resolveRuntimeBoundControllerUrl(
  credential: Pick<RuntimeControllerCredential, "controllerUrl">,
  selectedControllerUrl?: string | null,
): string {
  const selected = clean(selectedControllerUrl) ?? credential.controllerUrl;
  if (
    validatedControllerOrigin(selected, "The selected controller URL") !==
    validatedControllerOrigin(credential.controllerUrl, "CONTROLLER_BASE_URL")
  ) {
    throw new Error(
      "Refusing to send a runtime-scoped credential to a controller origin other than CONTROLLER_BASE_URL.",
    );
  }
  return selected;
}
