function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseGithubRepoOwnerName(
  input: string,
): { owner: string; repo: string } | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  let candidate = raw;
  if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.slice("git@github.com:".length);
  } else if (candidate.startsWith("ssh://git@github.com/")) {
    candidate = candidate.slice("ssh://git@github.com/".length);
  } else if (/^(?:www\.)?github\.com\//i.test(candidate)) {
    candidate = candidate.replace(/^(?:www\.)?github\.com\//i, "");
  } else {
    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase();
      if (host !== "github.com" && host !== "www.github.com") {
        return null;
      }
      candidate = parsed.pathname.replace(/^\/+/, "");
    } catch {
      // Keep raw owner/repo style inputs as-is.
    }
  }

  candidate =
    candidate
      .split(/[?#]/, 1)[0]
      ?.trim()
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "") ?? "";
  if (!candidate) {
    return null;
  }

  const parts = candidate
    .split("/")
    .filter((segment) => segment.trim().length > 0);
  if (parts.length !== 2) {
    return null;
  }
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  const validSegment = (value: string) =>
    value !== "." && value !== ".." && /^[a-z0-9_.-]+$/i.test(value);
  if (!validSegment(owner) || !validSegment(repo)) {
    return null;
  }
  return { owner, repo };
}

export function extractExplicitGithubRepoReference(message: string): string | null {
  const candidates = message
    .split(/\s+/)
    .map((part) => part.trim().replace(/^[<([{]+|[>),.]+$/g, ""))
    .filter((part) => part.length > 0);

  for (const candidate of candidates) {
    if (!candidate.toLowerCase().includes("github.com/")) {
      continue;
    }
    if (parseGithubRepoOwnerName(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function deriveGithubImportTargetPath(input: string): string {
  const parsed = parseGithubRepoOwnerName(input);
  if (!parsed) {
    return "repos/imported-repo";
  }
  const owner = sanitizePathSegment(parsed.owner);
  const repo = sanitizePathSegment(parsed.repo);
  const suffix = [owner, repo].filter((segment) => segment.length > 0).join("-");
  return `repos/${suffix || "imported-repo"}`;
}
