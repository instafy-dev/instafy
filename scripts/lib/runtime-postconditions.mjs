function normalizeJson(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }
  if (typeof value === "object") {
    return value;
  }
  return null;
}

function decodeBase64ToString(encoded) {
  if (typeof encoded !== "string" || encoded.trim().length === 0) {
    return "";
  }
  try {
    return Buffer.from(encoded, "base64").toString("utf-8");
  } catch (_error) {
    return "";
  }
}

function pickFileContent(file) {
  if (!file || typeof file !== "object") return "";
  const candidates = [file.content, file.generated, file.modified, file.html];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  const base64Candidates = [file.content_base64, file.contentBase64];
  for (const candidate of base64Candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const decoded = decodeBase64ToString(candidate);
      if (decoded.trim().length > 0) {
        return decoded;
      }
    }
  }
  return "";
}

export async function assertJobPostConditions({
  fetchJson,
  joinUrl,
  apiUrl,
  headers,
  projectId,
  jobId,
  expectedPrompt,
  expectedText,
  readWorkspaceFile
}) {
  const jobRows = await fetchJson(
    joinUrl(apiUrl, `/rest/v1/agent_jobs?id=eq.${jobId}&select=id,payload,artifacts,summary`),
    {
      method: "GET",
      headers
    }
  );
  const job = Array.isArray(jobRows) ? jobRows[0] : null;
  if (!job) {
    throw new Error(`agent job ${jobId} not found for project ${projectId}`);
  }

  const payload = normalizeJson(job.payload) ?? {};
  const promptText =
    (typeof payload === "object" && payload
      ? payload.prompt_text || payload.promptText || payload?.metadata?.prompt
      : null) ?? "";
  if (expectedPrompt && promptText) {
    const normalizedPrompt = promptText.trim().toLowerCase();
    if (!normalizedPrompt.includes(expectedPrompt.trim().toLowerCase())) {
      throw new Error(
        `agent job prompt mismatch. expected to include "${expectedPrompt}" but saw "${promptText}"`
      );
    }
  }

  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : normalizeJson(job.artifacts) ?? [];
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("agent job artifacts missing apply/files payload");
  }

  const applyArtifact = artifacts.find(
    (artifact) => artifact?.kind === "apply/files" || artifact?.kind === "apply"
  );
  if (!applyArtifact) {
    throw new Error("apply/files artifact not found on completed job");
  }

  const artifactFiles = Array.isArray(applyArtifact.files)
    ? applyArtifact.files
    : normalizeJson(applyArtifact.files) ?? [];

  if (!Array.isArray(artifactFiles) || artifactFiles.length === 0) {
    throw new Error("apply/files artifact missing files collection");
  }

  const indexArtifact = artifactFiles.find((file) => {
    const rawPath = (file?.path || file?.id || "").toString().toLowerCase();
    return rawPath.endsWith("index.html") || rawPath.includes("/index");
  });

  if (!indexArtifact) {
    throw new Error("index.html artifact was not produced by the apply job");
  }

  let indexContent = pickFileContent(indexArtifact);

  if (typeof readWorkspaceFile === "function" && (!indexContent || !indexContent.trim())) {
    const workspacePathCandidate =
      (typeof indexArtifact.workspacePath === "string" && indexArtifact.workspacePath) ||
      (typeof indexArtifact.path === "string" && indexArtifact.path) ||
      (typeof indexArtifact.id === "string" && indexArtifact.id) ||
      "";
    if (workspacePathCandidate) {
      try {
        const workspaceContent = await readWorkspaceFile(workspacePathCandidate);
        if (typeof workspaceContent === "string" && workspaceContent.trim()) {
          indexContent = workspaceContent;
        }
      } catch (error) {
        console.warn(
          "[runtime-postconditions] Failed to read workspace file",
          workspacePathCandidate,
          error?.message ?? error
        );
      }
    }
  }

  if (!indexContent || !indexContent.trim()) {
    throw new Error("index.html artifact is empty");
  }

  const expectedSnippets = Array.isArray(expectedText)
    ? expectedText.filter(Boolean)
    : expectedText
      ? [expectedText]
      : [];

  for (const snippet of expectedSnippets) {
    if (!indexContent.toLowerCase().includes(snippet.trim().toLowerCase())) {
      throw new Error(
        `index.html artifact does not include expected text "${snippet}"`
      );
    }
  }
}
