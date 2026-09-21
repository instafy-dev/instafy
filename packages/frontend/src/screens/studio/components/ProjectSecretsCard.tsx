import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeClosed, Plus } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Heading } from "../../../components/Heading";
import { Button } from "../../../components/Button";
import { Checkbox } from "../../../components/Checkbox";
import { ToggleIconButton } from "../../../components/ToggleIconButton";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { Textarea } from "../../../components/Textarea";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import {
  controllerClient,
  type ControllerAgentProfile,
  type ControllerProjectSecret,
} from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { useAuth } from "../../../providers/AuthProvider";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import {
  clearPendingProjectSecretPrefill,
  readPendingProjectSecretPrefill,
  setPendingProjectSecretPrefill,
  type PendingProjectSecretPrefill,
} from "./secretManagerDeepLink";
import { SettingsSurface } from "./SettingsSurface";

type SecretModalMode = "create" | "edit";
type TextSecurityStyle = CSSProperties & {
  WebkitTextSecurity?: string;
};

function normalizeAgentHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

function SecretModal({
  isOpen,
  mode,
  pending,
  title,
  name,
  nameDisabled,
  onNameChange,
  description,
  onDescriptionChange,
  value,
  onValueChange,
  valueVisible,
  onToggleValueVisible,
  agents,
  agentsLoading,
  agentsError,
  onRetryAgents,
  selectedAgentHandles,
  onToggleAgentHandle,
  autoFocusValue,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  mode: SecretModalMode;
  pending: boolean;
  title: string;
  name: string;
  nameDisabled?: boolean;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  value: string;
  onValueChange: (value: string) => void;
  valueVisible: boolean;
  onToggleValueVisible: () => void;
  agents: ControllerAgentProfile[];
  agentsLoading: boolean;
  agentsError: string | null;
  onRetryAgents: () => void;
  selectedAgentHandles: Set<string>;
  onToggleAgentHandle: (agentHandle: string) => void;
  autoFocusValue?: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const saveLabel = mode === "create" ? "Create" : "Save";
  const valuePlaceholder = mode === "edit" ? "Leave blank to keep current value" : "";
  const valueInputRef = useRef<HTMLInputElement | null>(null);
  const didAutoFocusRef = useRef(false);
  const canMaskWithTextSecurity = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      const style = window.document?.documentElement?.style;
      if (style && ("WebkitTextSecurity" in style || "webkitTextSecurity" in style)) {
        return true;
      }
    } catch {
      // Ignore style access failures and fall back to CSS.supports.
    }
    const cssSupports = (
      window as unknown as { CSS?: { supports?: (property: string, value: string) => boolean } }
    ).CSS?.supports;
    if (typeof cssSupports !== "function") {
      return false;
    }
    try {
      return cssSupports("-webkit-text-security", "disc");
    } catch {
      return false;
    }
  }, []);

  const valueInputType = valueVisible ? "text" : canMaskWithTextSecurity ? "text" : "password";
  const valueInputStyle: TextSecurityStyle | undefined =
    !valueVisible && canMaskWithTextSecurity ? { WebkitTextSecurity: "disc" } : undefined;

  useEffect(() => {
    if (!isOpen) {
      didAutoFocusRef.current = false;
      return;
    }
    if (!autoFocusValue) {
      return;
    }
    if (pending) {
      return;
    }
    if (didAutoFocusRef.current) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    didAutoFocusRef.current = true;
    const handle = window.setTimeout(() => {
      valueInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [autoFocusValue, isOpen, pending]);

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      isDismissable
      dialogAriaLabel={title}
      data-testid="project-secret-modal"
    >
      <StudioDialogHeader
        title={title}
        description="Secrets are injected into the runtime as environment variables."
        onClose={onClose}
        closeButtonDisabled={pending}
        closeLabel="Close"
      />

      <div className="space-y-3 px-5 py-4">
        <Field
          label="Name (env var)"
          htmlFor="project-secret-name"
          hint={
            <>
              Example: <span className="font-mono">GITHUB_TOKEN</span>,{" "}
              <span className="font-mono">CLOUDFLARE_API_TOKEN</span>
            </>
          }
        >
          <Input
            id="project-secret-name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="CLOUDFLARE_API_TOKEN"
            size="sm"
            radius="xl"
            disabled={pending || Boolean(nameDisabled)}
            name="project-secret-name"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="project-secret-name-input"
          />
        </Field>

        <Field label="Description" htmlFor="project-secret-description">
          <Textarea
            id="project-secret-description"
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="What this secret is used for (shown to humans)."
            rows={3}
            disabled={pending}
            name="project-secret-description"
            autoComplete="off"
            data-testid="project-secret-description-input"
          />
        </Field>

        <Field label="Value" htmlFor="project-secret-value">
          {/* Same geometry as the card in the chat: the reveal belongs inside
              the field, which is where the login password eye and every other
              trailing control in the product sits. The two secrets surfaces
              asked for the same value in two different shapes before this. */}
          <div className="relative">
            <Input
              id="project-secret-value"
              ref={valueInputRef}
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={valuePlaceholder}
              type={valueInputType}
              style={valueInputStyle}
              size="sm"
              radius="xl"
              className="pr-12"
              disabled={pending}
              name="project-secret-value"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-lpignore="true"
              data-bwignore="true"
              data-1p-ignore="true"
              data-testid="project-secret-value-input"
            />
            <ToggleIconButton
              appearance="bare"
              isSelected={valueVisible}
              size="sm"
              radius="full"
              aria-label={valueVisible ? "Hide value" : "Show value"}
              onPress={onToggleValueVisible}
              isDisabled={pending}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              data-testid="project-secret-toggle-value"
            >
              {valueVisible ? (
                <EyeClosed className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </ToggleIconButton>
          </div>
          <Text variant="caption" tone="muted" className="mt-1 font-normal">
            Never paste secret values into chat.
          </Text>
        </Field>

        <div className="space-y-2">
          <Text as="div" variant="caption" tone="muted" className="text-xs font-semibold">
            Allowed agents
          </Text>
          <div className="max-h-44 space-y-1 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900/40">
            {agentsLoading ? <LoadingStatus>Loading agents…</LoadingStatus> : null}
            {agentsError ? (
              <div className="space-y-2">
                <Text role="alert" tone="danger">{agentsError}</Text>
                <Button variant="outline" size="sm" onPress={onRetryAgents} isDisabled={agentsLoading}>Retry</Button>
              </div>
            ) : !agentsLoading && agents.length === 0 ? (
              <Text variant="caption" tone="muted" className="text-xs">
                No agents found yet.
              </Text>
            ) : (
              agents.map((agent) => (
                <Checkbox
                  key={agent.id}
                  isSelected={selectedAgentHandles.has(normalizeAgentHandle(agent.handle))}
                  onChange={() => onToggleAgentHandle(agent.handle)}
                  label={
                    <span className="inline-flex items-center gap-2">
                      <span className="font-semibold">@{agent.handle}</span>
                      {agent.handle === "octo" ? (
                        <Badge size="xs" tone="info">
                          Default
                        </Badge>
                      ) : null}
                    </span>
                  }
                  description={
                    agent.displayName || agent.description ? (
                      <span className="text-xxs">
                        {agent.displayName ? agent.displayName : agent.description}
                      </span>
                    ) : null
                  }
                  data-testid={`project-secret-agent-${agent.id}`}
                />
              ))
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
        <Button onPress={onClose} variant="ghost" size="sm" radius="full" isDisabled={pending}>
          Cancel
        </Button>
        <Button
          onPress={onSave}
          variant="primary"
          size="sm"
          radius="full"
          isDisabled={pending || agentsLoading || Boolean(agentsError)}
          data-testid="project-secret-save"
        >
          {pending ? "Working…" : saveLabel}
        </Button>
      </div>
    </StudioDialogModal>
  );
}

export function ProjectSecretsCard({ projectId }: { projectId: string | null }) {
  const { user } = useAuth();
  return <ScopedProjectSecretsCard key={`${user?.id}:${projectId}`} projectId={projectId} userId={user?.id ?? null} />;
}

function ScopedProjectSecretsCard({ projectId, userId }: { projectId: string | null; userId: string | null }) {
  const { showStatus } = useStatus();
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["project-secrets", userId, projectId] as const, [userId, projectId]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const secretsQuery = useQuery({
    queryKey,
    enabled: Boolean(userId && projectId),
    staleTime: 0,
    queryFn: async () => {
      const [secretsResult, agentsResult] = await Promise.all([
        controllerClient.secrets.listForProject(projectId!),
        controllerClient.agents.list({ projectId: projectId! }),
      ]);
      if (!secretsResult.success) throw new Error(secretsResult.error || "Unable to load secrets.");
      if (!agentsResult.success) throw new Error(agentsResult.error || "Unable to load agents.");
      return { secrets: secretsResult.secrets, agents: agentsResult.agents };
    },
  });
  const loading = secretsQuery.isFetching;
  const loadError = secretsQuery.error
    ? secretsQuery.data === undefined ? "Couldn't load secrets. Try again." : "Couldn't refresh secrets. Try again."
    : null;
  // A failed protected read can indicate revoked access. Never retain secret
  // metadata or agent names after that failure, or across project boundaries.
  const secrets = useMemo(() => loadError ? [] : secretsQuery.data?.secrets ?? [], [loadError, secretsQuery.data]);
  const agents = useMemo(() => loadError ? [] : secretsQuery.data?.agents ?? [], [loadError, secretsQuery.data]);
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);

  const [modalMode, setModalMode] = useState<SecretModalMode>("create");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [autoFocusValue, setAutoFocusValue] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [valueVisible, setValueVisible] = useState(false);
  const [selectedAgentHandles, setSelectedAgentHandles] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);

  const pendingPrefillRef = useRef<PendingProjectSecretPrefill | null>(null);
  const activeCreatePrefillRef = useRef<PendingProjectSecretPrefill | null>(null);

  const activeSecrets = useMemo(() => secrets.filter((secret) => !secret.revokedAt), [secrets]);
  const agentsById = useMemo(() => {
    const map = new Map<string, ControllerAgentProfile>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const { refetch } = secretsQuery;
  const loadData = useCallback(async () => {
    if (projectId && mountedRef.current) await refetch();
  }, [projectId, refetch]);

  useEffect(() => {
    if (!projectId) {
      pendingPrefillRef.current = null;
      return;
    }
    const pending = readPendingProjectSecretPrefill();
    if (!pending) {
      pendingPrefillRef.current = null;
      return;
    }
    if (pending.projectId && pending.projectId !== projectId) {
      pendingPrefillRef.current = null;
      return;
    }
    pendingPrefillRef.current = pending;
    clearPendingProjectSecretPrefill();
  }, [projectId]);

  const openCreateModal = useCallback(
    (prefill?: PendingProjectSecretPrefill | null) => {
      activeCreatePrefillRef.current = prefill ?? null;
      setModalMode("create");
      setEditingSecretId(null);
      setNameDraft(prefill?.name ?? "");
      setDescriptionDraft(prefill?.description ?? "");
      setValueDraft("");
      setValueVisible(false);
      setAutoFocusValue(Boolean(prefill?.name?.trim()));

      const handles = (prefill?.agentHandles ?? [])
        .map(normalizeAgentHandle)
        .filter((handle) => handle.length > 0);
      const defaults = handles.length > 0 ? handles : ["octo"];
      setSelectedAgentHandles(new Set(defaults));
      setModalOpen(true);
    },
    [],
  );

  useEffect(() => {
    if (!projectId) {
      return;
    }
    if (modalOpen) {
      return;
    }
    const pending = pendingPrefillRef.current;
    if (!pending) {
      return;
    }
    pendingPrefillRef.current = null;
    openCreateModal(pending);
  }, [modalOpen, openCreateModal, projectId]);

  const openEditModal = useCallback(
    (secret: ControllerProjectSecret) => {
      activeCreatePrefillRef.current = null;
      setModalMode("edit");
      setEditingSecretId(secret.id);
      setNameDraft(secret.name);
      setDescriptionDraft(secret.description ?? "");
      setValueDraft("");
      setValueVisible(false);
      setAutoFocusValue(false);
      const handles = (
        secret.agentHandles.length > 0
          ? secret.agentHandles
          : secret.agentIds
              .map((id) => agentsById.get(id)?.handle)
              .filter((value): value is string => Boolean(value))
      )
        .map(normalizeAgentHandle)
        .filter((handle) => handle.length > 0);
      const defaults = handles.length > 0 ? handles : ["octo"];
      setSelectedAgentHandles(new Set(defaults));
      setModalOpen(true);
    },
    [agentsById],
  );

  const closeModal = useCallback(() => {
    if (saving) {
      return;
    }
    activeCreatePrefillRef.current = null;
    setModalOpen(false);
    setAutoFocusValue(false);
  }, [saving]);

  const toggleAgentHandle = useCallback((agentHandle: string) => {
    const normalized = normalizeAgentHandle(agentHandle);
    setSelectedAgentHandles((current) => {
      const next = new Set(current);
      if (next.has(normalized)) {
        next.delete(normalized);
      } else {
        next.add(normalized);
      }
      return next;
    });
  }, []);

  const saveModal = useCallback(async () => {
    if (!projectId) {
      showStatus("Select a space before creating secrets.", "warning", 4000);
      return;
    }
    const name = nameDraft.trim();
    if (!name) {
      showStatus("Secret name is required.", "error", 4000);
      return;
    }

    setSaving(true);
    try {
      if (modalMode === "create") {
        const createPrefill = activeCreatePrefillRef.current;
        const value = valueDraft;
        if (!value.trim()) {
          showStatus("Secret value is required.", "error", 4000);
          return;
        }
        const result = await controllerClient.secrets.createForProject(projectId, {
          name,
          value,
          description: descriptionDraft.trim() ? descriptionDraft.trim() : null,
          agentHandles: Array.from(selectedAgentHandles),
        });
        if (result.success) await queryClient.invalidateQueries({ queryKey, exact: true });
        if (!mountedRef.current) return;
        if (!result.success) {
          showStatus(result.error ?? "Unable to create secret.", "error", 4500);
          return;
        }
        if (createPrefill?.remainingNames && createPrefill.remainingNames.length > 0) {
          const [nextName, ...rest] = createPrefill.remainingNames;
          setPendingProjectSecretPrefill({
            projectId,
            name: nextName,
            description: createPrefill.description ?? null,
            agentHandles: createPrefill.agentHandles,
            remainingNames: rest.length > 0 ? rest : undefined,
            returnPanelTab: createPrefill.returnPanelTab,
          });
        }
        showStatus("Secret created.", "success", 2500);
        if (createPrefill?.returnPanelTab === "chat") {
          requestUrlPush();
          openPanelTab("chat", { activate: true });
        }
      } else {
        const secretId = editingSecretId;
        if (!secretId) {
          showStatus("Missing secret id.", "error", 4000);
          return;
        }
        const result = await controllerClient.secrets.updateForProject(projectId, secretId, {
          description: descriptionDraft.trim() ? descriptionDraft.trim() : null,
          value: valueDraft.trim() ? valueDraft : undefined,
          agentHandles: Array.from(selectedAgentHandles),
        });
        if (result.success) await queryClient.invalidateQueries({ queryKey, exact: true });
        if (!mountedRef.current) return;
        if (!result.success) {
          showStatus(result.error ?? "Unable to update secret.", "error", 4500);
          return;
        }
        showStatus("Secret updated.", "success", 2500);
      }

      activeCreatePrefillRef.current = null;
      setModalOpen(false);
    } catch (error) {
      if (mountedRef.current) {
        showStatus(error instanceof Error ? error.message : "Unable to save secret.", "error", 4500);
      }
    } finally {
      setSaving(false);
    }
  }, [
    descriptionDraft,
    editingSecretId,
    modalMode,
    nameDraft,
    openPanelTab,
    projectId,
    queryClient,
    queryKey,
    requestUrlPush,
    selectedAgentHandles,
    showStatus,
    valueDraft,
  ]);

  const handleRevokeSecret = useCallback(
    async (secret: ControllerProjectSecret) => {
      if (!projectId) {
        return;
      }
      if (typeof window !== "undefined") {
        const ok = window.confirm(`Revoke ${secret.name}? This removes it from all agents.`);
        if (!ok) {
          return;
        }
      }
      setActionPendingId(secret.id);
      try {
        const result = await controllerClient.secrets.revokeForProject(projectId, secret.id);
        if (result.success) await queryClient.invalidateQueries({ queryKey, exact: true });
        if (!mountedRef.current) return;
        if (!result.success) {
          showStatus(result.error ?? "Unable to revoke secret.", "error", 4500);
          return;
        }
        showStatus("Secret revoked.", "success", 2500);
      } catch (error) {
        if (mountedRef.current) {
          showStatus(error instanceof Error ? error.message : "Unable to revoke secret.", "error", 4500);
        }
      } finally {
        setActionPendingId(null);
      }
    },
    [projectId, queryClient, queryKey, showStatus],
  );

  const assignedAgentsLabel = useCallback(
    (secret: ControllerProjectSecret) => {
      const handles =
        secret.agentHandles.length > 0
          ? secret.agentHandles
          : secret.agentIds
              .map((id) => agentsById.get(id)?.handle)
              .filter((value): value is string => Boolean(value));
      if (handles.length === 0) {
        return "Not assigned";
      }
      return handles.map((handle) => `@${handle}`).join(", ");
    },
    [agentsById],
  );

  const title = modalMode === "create" ? "Create secret" : "Edit secret";
  const nameDisabled = modalMode === "edit";

  return (
    <>
      <div className="space-y-3" data-testid="project-secrets-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Heading level={3}>Secrets</Heading>
          <Button
            onPress={() => openCreateModal(null)}
            isDisabled={!projectId || loading || Boolean(loadError)}
            variant="primary"
            size="sm"
            radius="xl"
            data-testid="project-secret-create"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create secret
          </Button>
        </div>
        {!projectId ? (
          <SettingsSurface>
            <Text variant="caption" tone="muted">
              Select a space to manage secrets.
            </Text>
          </SettingsSurface>
        ) : null}

        {loading ? (
          <LoadingStatus>{secretsQuery.data === undefined ? "Loading secrets…" : "Refreshing secrets…"}</LoadingStatus>
        ) : null}

        {loadError ? (
          <div className="flex flex-wrap items-center gap-3">
            <Text role="alert" tone="danger">{loadError}</Text>
            <Button variant="outline" size="sm" onPress={() => void loadData()} isDisabled={loading}>
              Retry
            </Button>
          </div>
        ) : null}

        {projectId ? (
          <div className="space-y-3">
            {!loading && !loadError && activeSecrets.length === 0 ? (
              <SettingsSurface className="space-y-1">
                <Text variant="bodyStrong" tone="secondary">
                  No secrets yet.
                </Text>
                <Text variant="body" tone="muted">
                  Store API keys and tokens for agents and runtimes in this space.
                </Text>
              </SettingsSurface>
            ) : (
              <SettingsSurface padding="none" className="overflow-hidden">
                <ul className="divide-y divide-slate-200/70 dark:divide-slate-800">
                {activeSecrets.map((secret) => {
                  const busy = actionPendingId === secret.id;
                  return (
                    <li
                      key={secret.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5"
                      data-testid={`project-secret-row-${secret.id}`}
                    >
                      <div className="min-w-0">
                        <Text variant="bodyStrong" tone="primary" className="font-mono text-sm">
                          {secret.name}
                        </Text>
                        <Text variant="caption" tone="muted" className="mt-0.5">
                          {secret.description ?? "No description"}
                        </Text>
                        <Text variant="caption" tone="muted" className="mt-0.5 text-xxs">
                          Agents: {assignedAgentsLabel(secret)}
                        </Text>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          onPress={() => openEditModal(secret)}
                          variant="ghost"
                          size="xs"
                          radius="full"
                          isDisabled={busy}
                          data-testid={`project-secret-edit-${secret.id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          onPress={() => void handleRevokeSecret(secret)}
                          variant="outline"
                          size="xs"
                          radius="full"
                          isDisabled={busy}
                          data-testid={`project-secret-revoke-${secret.id}`}
                        >
                          {busy ? "Working…" : "Revoke"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
                </ul>
              </SettingsSurface>
            )}
          </div>
        ) : null}
      </div>

      <SecretModal
        isOpen={modalOpen}
        mode={modalMode}
        pending={saving}
        title={title}
        name={nameDraft}
        nameDisabled={nameDisabled}
        onNameChange={setNameDraft}
        description={descriptionDraft}
        onDescriptionChange={setDescriptionDraft}
        value={valueDraft}
        onValueChange={setValueDraft}
        valueVisible={valueVisible}
        onToggleValueVisible={() => setValueVisible((value) => !value)}
        agents={agents}
        agentsLoading={loading}
        agentsError={loadError}
        onRetryAgents={() => void loadData()}
        selectedAgentHandles={selectedAgentHandles}
        onToggleAgentHandle={toggleAgentHandle}
        autoFocusValue={autoFocusValue}
        onClose={closeModal}
        onSave={() => void saveModal()}
      />
    </>
  );
}
