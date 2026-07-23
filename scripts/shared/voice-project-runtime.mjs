function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanControllerUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function buildAutoProjectName(prefix = "Voice") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix} ${stamp}`;
}

async function fetchControllerJson(controllerUrl, pathName, { token, method = "GET", body } = {}) {
  const response = await fetch(`${cleanControllerUrl(controllerUrl)}${pathName}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Controller request ${method} ${pathName} failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return response.json().catch(() => null);
}

export async function ensureProjectContext({
  controllerUrl,
  accessToken,
  projectId,
  orgId,
  ownerUserId,
  projectNamePrefix = "Voice",
}) {
  if (typeof projectId === "string" && projectId.trim()) {
    return {
      projectId: projectId.trim(),
      orgId: typeof orgId === "string" && orgId.trim() ? orgId.trim() : null,
    };
  }

  let resolvedOrgId = typeof orgId === "string" && orgId.trim() ? orgId.trim() : "";
  if (!resolvedOrgId) {
    const orgResponse = await fetchControllerJson(controllerUrl, "/orgs", {
      token: accessToken,
      method: "POST",
      body: {
        orgName: buildAutoProjectName(projectNamePrefix),
      },
    });
    const createdOrgId =
      typeof orgResponse?.orgId === "string"
        ? orgResponse.orgId.trim()
        : typeof orgResponse?.org_id === "string"
          ? orgResponse.org_id.trim()
          : typeof orgResponse?.id === "string"
            ? orgResponse.id.trim()
            : "";
    if (!createdOrgId) {
      throw new Error("Voice project bootstrap did not return an org id.");
    }
    resolvedOrgId = createdOrgId;
  }

  const projectResponse = await fetchControllerJson(
    controllerUrl,
    `/orgs/${encodeURIComponent(resolvedOrgId)}/projects`,
    {
      token: accessToken,
      method: "POST",
      body: {
        projectType: "customer",
        projectName: buildAutoProjectName(projectNamePrefix),
        ...(ownerUserId ? { ownerUserId } : {}),
      },
    },
  );

  const createdProjectId =
    typeof projectResponse?.projectId === "string"
      ? projectResponse.projectId.trim()
      : typeof projectResponse?.project_id === "string"
        ? projectResponse.project_id.trim()
        : typeof projectResponse?.id === "string"
          ? projectResponse.id.trim()
          : "";
  if (!createdProjectId) {
    throw new Error("Voice project bootstrap did not return a project id.");
  }

  return {
    projectId: createdProjectId,
    orgId: resolvedOrgId,
  };
}

export function runtimeEntryIsReady(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const status = String(entry.status || "").trim().toLowerCase();
  const health = String(entry.health || "").trim().toLowerCase();
  const statusReady = status.length === 0 || status === "ready" || status === "running";
  const healthReady = health === "online" || health === "idle";
  return statusReady && healthReady;
}

export async function ensureHostedRuntimeReady({
  controllerUrl,
  projectId,
  accessToken,
  timeoutMs = 120_000,
}) {
  await fetchControllerJson(controllerUrl, "/runtime/ensure", {
    token: accessToken,
    method: "POST",
    body: {
      project_id: projectId,
      provider: "instafy-cloud",
      display_name: "Hosted Runtime",
      origin_mode: "hosted",
      origin_protocols: ["http"],
    },
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await fetchControllerJson(
      controllerUrl,
      `/projects/${encodeURIComponent(projectId)}/runtime/status`,
      { token: accessToken },
    ).catch(() => null);
    const readyRuntime =
      payload?.runtimes?.find?.((entry) => !entry?.isLocal && runtimeEntryIsReady(entry)) ?? null;
    if (readyRuntime?.runtimeId) {
      return readyRuntime;
    }
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for a hosted runtime to reach ready state for project ${projectId}.`);
}
