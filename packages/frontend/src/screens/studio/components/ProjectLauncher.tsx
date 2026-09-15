import { FormEvent, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Heading } from "../../../components/Heading";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { Surface } from "../../../components/Surface";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import { getOrgDisambiguator, getOrgDisplayName } from "../../../org/orgNaming";
import { type ControllerOrgSummary } from "../../../sdk/instafy";
import { useDeviceAuthFlow } from "./device-auth/useDeviceAuthFlow";
import { NewTeamDialog } from "./NewTeamDialog";

export interface ProjectLauncherProps {
  open: boolean;
  preferredOrgId?: string | null;
  onClose: () => void;
  onCreateBlank: (
    projectName: string,
    org: { orgId?: string | null; orgSlug?: string | null; orgName?: string | null },
  ) => Promise<void> | void;
  onCreateFromGithub: (
    projectName: string,
    org: { orgId?: string | null; orgSlug?: string | null; orgName?: string | null },
    github: { repo: string; ref?: string | null; githubDeviceAuthSessionId?: string | null },
  ) => Promise<{ success: boolean; error?: string | null }> | { success: boolean; error?: string | null };
}

export function ProjectLauncher({
  open,
  preferredOrgId = null,
  onClose,
  onCreateBlank,
  onCreateFromGithub
}: ProjectLauncherProps) {
  // Intentionally empty: Create stays disabled until the user names the
  // space, so default-named "New Space" debris can't pile up.
  const [projectName, setProjectName] = useState("");
  const [mode, setMode] = useState<"blank" | "github">("blank");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubRef, setGithubRef] = useState("");
  const [githubImportError, setGithubImportError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<ControllerOrgSummary[]>([]);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);
  const [processingElapsedSeconds, setProcessingElapsedSeconds] = useState(0);
  const { showStatus } = useStatus();
  const projectNameInputRef = useRef<HTMLInputElement | null>(null);
  const githubDeviceAuth = useDeviceAuthFlow({
    onCompleted: async () => {
      showStatus("GitHub connected.", "success", 3000);
      return { success: true };
    },
  });
  const githubDeviceAuthSession = githubDeviceAuth.session;
  const githubDeviceAuthError = githubDeviceAuth.error;
  const beginGithubDeviceAuthFlow = githubDeviceAuth.begin;
  const cancelGithubDeviceAuthFlow = githubDeviceAuth.cancel;
  const clearGithubDeviceAuthError = githubDeviceAuth.clearError;
  const resetGithubDeviceAuth = githubDeviceAuth.reset;

  const orgSelectOptions = useMemo(() => {
    const base = orgs.map((org) => {
      const roleSuffix = org.role ? ` (${org.role})` : "";
      const baseLabel = `${getOrgDisplayName(org.name)}${roleSuffix}`;
      return { ...org, baseLabel };
    });
    const labelCounts = new Map<string, number>();
    base.forEach((org) => {
      labelCounts.set(org.baseLabel, (labelCounts.get(org.baseLabel) ?? 0) + 1);
    });
    return base.map((org) => {
      if ((labelCounts.get(org.baseLabel) ?? 0) <= 1) {
        return { ...org, label: org.baseLabel };
      }
      const suffix = getOrgDisambiguator(org.slug, org.id);
      return { ...org, label: `${org.baseLabel} • ${suffix}` };
    });
  }, [orgs]);

  useEffect(() => {
    if (open) {
      setProjectName("");
      setMode("blank");
      setGithubRepo("");
      setGithubRef("");
      resetGithubDeviceAuth();
      setGithubImportError(null);
      setIsProcessing(false);
      setProcessingStartedAt(null);
      setProcessingElapsedSeconds(0);
      setOrgError(null);
      setNewTeamOpen(false);
      setSelectedOrgId(null);
      setOrgLoading(true);
      controllerClient.organizations.list()
        .then((list) => {
          setOrgs(list);
          if (preferredOrgId && list.some((org) => org.id === preferredOrgId)) {
            setSelectedOrgId(preferredOrgId);
          } else if (list.length === 1) {
            setSelectedOrgId(list[0].id);
          }
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : "Unable to load teams.";
          setOrgError(message);
          console.warn("[ProjectLauncher] org list error", message);
        })
        .finally(() => setOrgLoading(false));
    }
  }, [open, preferredOrgId, resetGithubDeviceAuth]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const node = projectNameInputRef.current;
    if (!node) {
      return;
    }
    node.focus();
    node.select();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !newTeamOpen) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newTeamOpen, onClose, open]);

  const beginGithubDeviceAuth = useCallback(async () => {
    if (isProcessing) {
      return;
    }
    await beginGithubDeviceAuthFlow({ provider: "github" });
  }, [beginGithubDeviceAuthFlow, isProcessing]);

  const cancelGithubDeviceAuthSession = useCallback(async () => {
    clearGithubDeviceAuthError();
    await cancelGithubDeviceAuthFlow();
  }, [cancelGithubDeviceAuthFlow, clearGithubDeviceAuthError]);

  useEffect(() => {
    if (!isProcessing || mode !== "github") {
      setProcessingStartedAt(null);
      setProcessingElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    setProcessingStartedAt(startedAt);
    setProcessingElapsedSeconds(0);

    const intervalId = window.setInterval(() => {
      setProcessingElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isProcessing, mode]);

  if (!open) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = projectName.trim();
    if (!trimmed) {
      showStatus("Please enter a space name.", "warning", 3000);
      return;
    }
    const orgPayload = selectedOrgId ? { orgId: selectedOrgId } : {};
    setIsProcessing(true);
    try {
      if (mode === "github") {
        setGithubImportError(null);
        const repo = githubRepo.trim();
        if (!repo) {
          setGithubImportError("Paste a GitHub repo URL (or owner/repo).");
          return;
        }
        const result = await onCreateFromGithub(trimmed, orgPayload, {
          repo,
          ref: githubRef.trim() || null,
          githubDeviceAuthSessionId:
            githubDeviceAuthSession?.status === "completed" ? githubDeviceAuthSession.sessionId : null,
        });
        if (!result?.success) {
          setGithubImportError(result?.error ?? "GitHub import failed.");
          return;
        }
      } else {
        await onCreateBlank(trimmed, orgPayload);
      }
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to create space right now.";
      if (mode === "github") {
        setGithubImportError(message);
      } else {
        showStatus(message, "error", 4000);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 backdrop-blur-sm pb-[max(var(--instafy-safe-area-inset-bottom),2rem)] pl-[max(var(--instafy-safe-area-inset-left),0.75rem)] pr-[max(var(--instafy-safe-area-inset-right),0.75rem)] pt-[max(var(--instafy-safe-area-inset-top),2rem)] sm:items-center sm:pl-[max(var(--instafy-safe-area-inset-left),1.25rem)] sm:pr-[max(var(--instafy-safe-area-inset-right),1.25rem)]"
      data-testid="project-launcher-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Surface
        tone="default"
        radius="3xl"
        shadow="lg"
        className="relative max-h-full w-full max-w-lg overflow-x-hidden overflow-y-auto shadow-2xl dark:shadow-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-launcher-title"
        aria-describedby="project-launcher-description"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 bg-slate-50/70 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/30">
          <div className="min-w-0">
            <Heading id="project-launcher-title" level={2} className="mt-1">
              Create a new space
            </Heading>
          </div>
          <IconButton
            onPress={onClose}
            variant="ghost"
            size="xs"
            radius="full"
            data-testid="project-launcher-close"
            aria-label="Close"
          >
            <Xmark className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onPress={() => {
                setMode("blank");
                setGithubImportError(null);
              }}
              variant={mode === "blank" ? "primary" : "outline"}
              size="xs"
              radius="full"
              isDisabled={isProcessing}
              data-testid="project-launcher-mode-blank"
            >
              Start from scratch
            </Button>
            <Button
              onPress={() => {
                setMode("github");
                setGithubImportError(null);
              }}
              variant={mode === "github" ? "primary" : "outline"}
              size="xs"
              radius="full"
              isDisabled={isProcessing}
              data-testid="project-launcher-mode-github"
            >
              Import from GitHub
            </Button>
          </div>

          <Field label="Space name" htmlFor="project-launcher-name">
            <Input
              id="project-launcher-name"
              ref={projectNameInputRef}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="e.g. Summer launch site"
              data-testid="project-launcher-name-input"
            />
          </Field>
          <Field label="Team" htmlFor="project-launcher-org-select" error={orgError}>
            <div className="space-y-1.5">
              <Select
                id="project-launcher-org-select"
                disabled={orgLoading || isProcessing}
                value={selectedOrgId ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "new") setNewTeamOpen(true);
                  else setSelectedOrgId(value || null);
                }}
                data-testid="project-launcher-org-select"
              >
                <option value="">Choose team</option>
                {orgSelectOptions.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.label}
                  </option>
                ))}
                <option value="new">+ Create new team</option>
              </Select>
            </div>
          </Field>

          {mode === "github" ? (
            <div className="space-y-3 rounded-2xl border border-slate-200/70 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/20">
              <div className="space-y-1.5">
                <Text as="span" variant="bodyStrong" tone="secondary">
                  GitHub repository
                </Text>
                <Input
                  value={githubRepo}
                  onChange={(event) => {
                    setGithubRepo(event.target.value);
                    setGithubImportError(null);
                  }}
                  placeholder="https://github.com/owner/repo or owner/repo"
                  data-testid="project-launcher-github-repo-input"
                />
              </div>
              <div className="space-y-1.5">
                <Text as="span" variant="bodyStrong" tone="secondary">
                  Ref (optional)
                </Text>
                <Input
                  value={githubRef}
                  onChange={(event) => {
                    setGithubRef(event.target.value);
                    setGithubImportError(null);
                  }}
                  placeholder="main, v1.2.3, or commit SHA (defaults to HEAD)"
                  data-testid="project-launcher-github-ref-input"
                  />
              </div>
              <Text as="p" variant="caption" tone="muted">
                Public repos import without login. For private repos, connect GitHub (device code) and keep this page open.
              </Text>
              {githubDeviceAuthError ? (
                <Text as="p" variant="caption" tone="inherit" className="text-rose-600 dark:text-rose-300">
                  {githubDeviceAuthError}
                </Text>
              ) : null}
              {githubDeviceAuthSession ? (
                <div className="space-y-2 rounded-2xl border border-slate-200/70 bg-white px-3 py-2.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
                  <div className="font-semibold text-slate-700 dark:text-slate-100">GitHub device login</div>
                  {githubDeviceAuthSession.status === "completed" ? (
                    <Text as="div" variant="caption" tone="muted" className="mt-1 text-xs">
                      Connected — private repos will import using this GitHub account (email doesn&apos;t need to match your Instafy
                      profile).
                    </Text>
                  ) : (
                    <>
                      <Text as="div" variant="caption" tone="muted" className="mt-1 text-xs">
                        Open the login page and enter this one-time code:
                      </Text>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold tracking-wide text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                          {githubDeviceAuthSession.userCode}
                        </code>
                        <Button
                          onPress={() => {
                            try {
                              void navigator.clipboard?.writeText(githubDeviceAuthSession.userCode);
                            } catch {
                              // ignore
                            }
                          }}
                          variant="ghost"
                          size="xs"
                          radius="full"
                          isDisabled={isProcessing}
                        >
                          Copy code
                        </Button>
                        <Button
                          onPress={() => void openExternalUrl(githubDeviceAuthSession.verificationUrl)}
                          variant="primary"
                          size="xs"
                          radius="full"
                          isDisabled={isProcessing}
                        >
                          Open login
                        </Button>
                        <Button
                          onPress={cancelGithubDeviceAuthSession}
                          variant="ghost"
                          size="xs"
                          radius="full"
                          isDisabled={isProcessing}
                        >
                          Cancel
                        </Button>
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-300">
                        {githubDeviceAuthSession.status === "pending" ? (
                          <>
                            <Spinner aria-hidden="true" tone="slate" size="xs" />
                            <span>Waiting for you to finish login…</span>
                          </>
                        ) : githubDeviceAuthSession.status === "failed" ? (
                          <span className="text-rose-600 dark:text-rose-400">
                            {githubDeviceAuthSession.error ?? "GitHub device login failed."}
                          </span>
                        ) : null}
                      </div>
                      {githubDeviceAuthSession.status === "failed" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            onPress={beginGithubDeviceAuth}
                            variant="primary"
                            size="xs"
                            radius="full"
                            isDisabled={isProcessing}
                          >
                            Try again
                          </Button>
                          <Button
                            onPress={cancelGithubDeviceAuthSession}
                            variant="ghost"
                            size="xs"
                            radius="full"
                            isDisabled={isProcessing}
                          >
                            Back
                          </Button>
                        </div>
                      ) : null}
                    </>
                  )}
                  {githubDeviceAuthSession.status === "completed" ? (
                    <div className="mt-2 flex justify-end">
                      <Button
                        onPress={cancelGithubDeviceAuthSession}
                        variant="ghost"
                        size="xs"
                        radius="full"
                        isDisabled={isProcessing}
                      >
                        Disconnect
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-center justify-end">
                  <Button
                    onPress={beginGithubDeviceAuth}
                    variant="outline"
                    size="xs"
                    radius="full"
                    isDisabled={isProcessing}
                  >
                    Connect GitHub (private repos)
                  </Button>
                </div>
              )}
              {githubImportError ? (
                <Text as="p" variant="caption" tone="inherit" className="break-words text-rose-600 dark:text-rose-300">
                  {githubImportError}
                </Text>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
            <Button
              onPress={onClose}
              variant="outline"
              size="sm"
              radius="lg"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              isDisabled={
                isProcessing ||
                !projectName.trim() ||
                (mode === "github" && githubRepo.trim().length === 0)
              }
              variant="primary"
              size="sm"
              radius="lg"
              data-testid={
                mode === "github"
                  ? "project-launcher-create-github"
                  : "project-launcher-create-blank"
              }
            >
              {isProcessing ? (
                <>
                  <Spinner aria-hidden="true" tone="slate" size="xs" />
                  {mode === "github" ? "Creating & importing…" : "Creating…"}
                </>
              ) : mode === "github" ? (
                "Create & import"
              ) : (
                "Create"
              )}
            </Button>
          </div>
          {isProcessing && mode === "github" ? (
            <Text as="p" variant="caption" tone="muted" className="text-right text-xs">
              Import in progress{processingStartedAt ? ` (${processingElapsedSeconds}s)` : ""}. Large repositories can take a few minutes.
            </Text>
          ) : null}
        </form>
      </Surface>
    </div>
    <NewTeamDialog open={newTeamOpen} allowCustomSlug onClose={() => setNewTeamOpen(false)}
      onCreated={(organization) => {
        setOrgs((previous) => [...previous.filter((org) => org.id !== organization.id), organization]);
        setSelectedOrgId(organization.id);
      }} />
    </>
  );
}
