import { Field } from "../../../components/Field";
import { useCallback, useId, useMemo, useState } from "react";
import { Eye, EyeClosed } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { Spinner } from "../../../components/Spinner";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";

type InlineSecretDescriptor = {
  name: string;
  description?: string | null;
};

type SecretValueDraft = {
  value: string;
  visible: boolean;
};

function normalizeSecretName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createDefaultDraft(): SecretValueDraft {
  return { value: "", visible: false };
}

export function InlineSecretsForm({
  projectId,
  secrets,
  description,
  agentHandles,
  onSaved,
}: {
  projectId: string | null;
  secrets: InlineSecretDescriptor[];
  description?: string | null;
  agentHandles?: string[];
  onSaved?: (names: string[]) => void;
}) {
  const fieldId = useId();
  const { showStatus } = useStatus();
  const normalizedSecrets = useMemo(() => {
    const out: InlineSecretDescriptor[] = [];
    const seen = new Set<string>();
    for (const secret of secrets) {
      const name = normalizeSecretName(secret.name);
      if (!name) {
        continue;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        name,
        description: typeof secret.description === "string" ? secret.description.trim() : null,
      });
    }
    return out;
  }, [secrets]);

  const [drafts, setDrafts] = useState<Record<string, SecretValueDraft>>(() => {
    const initial: Record<string, SecretValueDraft> = {};
    for (const secret of normalizedSecrets) {
      initial[secret.name] = createDefaultDraft();
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [savedAtByName, setSavedAtByName] = useState<Record<string, number>>({});

  const missingNames = useMemo(() => {
    const missing: string[] = [];
    for (const secret of normalizedSecrets) {
      const draft = drafts[secret.name];
      if (!draft?.value.trim()) {
        missing.push(secret.name);
      }
    }
    return missing;
  }, [drafts, normalizedSecrets]);

  const canSave = Boolean(projectId) && normalizedSecrets.length > 0 && missingNames.length === 0 && !saving;

  const setDraftValue = useCallback((name: string, value: string) => {
    setDrafts((current) => ({
      ...current,
      [name]: {
        ...(current[name] ?? createDefaultDraft()),
        value,
      },
    }));
  }, []);

  const toggleDraftVisible = useCallback((name: string) => {
    setDrafts((current) => {
      const existing = current[name] ?? createDefaultDraft();
      return {
        ...current,
        [name]: {
          ...existing,
          visible: !existing.visible,
        },
      };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!projectId) {
      return;
    }
    if (normalizedSecrets.length === 0) {
      return;
    }
    if (missingNames.length > 0) {
      showStatus(`Missing values for: ${missingNames.slice(0, 3).join(", ")}`, "warning", 3500);
      return;
    }
    if (saving) {
      return;
    }

    setSaving(true);
    try {
      const existing = await controllerClient.secrets.listForProject(projectId);
      if (!existing.success) {
        showStatus(existing.error ?? "Unable to load current secrets.", "error", 5000);
        return;
      }

      const existingByName = new Map<string, string>();
      for (const secret of existing.secrets) {
        existingByName.set(secret.name.toLowerCase(), secret.id);
      }

      const savedNames: string[] = [];

      for (const secret of normalizedSecrets) {
        const draft = drafts[secret.name];
        const value = draft?.value ?? "";
        const trimmedValue = value.trim();
        if (!trimmedValue) {
          continue;
        }

        const effectiveDescription =
          secret.description ??
          (typeof description === "string" && description.trim().length > 0
            ? description.trim()
            : null);
        const agentHandlesValue = agentHandles && agentHandles.length > 0 ? agentHandles : undefined;

        const existingId = existingByName.get(secret.name.toLowerCase());
        if (existingId) {
          const updated = await controllerClient.secrets.updateForProject(
            projectId,
            existingId,
            {
              value: trimmedValue,
              ...(effectiveDescription !== undefined
                ? { description: effectiveDescription }
                : {}),
              ...(agentHandlesValue ? { agentHandles: agentHandlesValue } : {}),
            },
          );
          if (!updated.success) {
            showStatus(updated.error ?? `Unable to update ${secret.name}`, "error", 5000);
            return;
          }
          savedNames.push(secret.name);
          continue;
        }

        const created = await controllerClient.secrets.createForProject(projectId, {
          name: secret.name,
          value: trimmedValue,
          ...(effectiveDescription !== undefined ? { description: effectiveDescription } : {}),
          ...(agentHandlesValue ? { agentHandles: agentHandlesValue } : {}),
        });
        if (!created.success) {
          showStatus(created.error ?? `Unable to save ${secret.name}`, "error", 5000);
          return;
        }
        savedNames.push(secret.name);
      }

      if (savedNames.length === 0) {
        showStatus("Nothing to save.", "warning", 2500);
        return;
      }

      showStatus(
        savedNames.length === 1 ? `Saved ${savedNames[0]}.` : `Saved ${savedNames.length} secrets.`,
        "success",
        3000,
      );
      onSaved?.(savedNames);
      setSavedAtByName((current) => {
        const next: Record<string, number> = { ...current };
        const now = Date.now();
        for (const name of savedNames) {
          next[name] = now;
        }
        return next;
      });
      setDrafts((current) => {
        const next: Record<string, SecretValueDraft> = { ...current };
        for (const name of savedNames) {
          next[name] = { ...createDefaultDraft(), visible: next[name]?.visible ?? false };
        }
        return next;
      });
    } finally {
      setSaving(false);
    }
  }, [
    agentHandles,
    description,
    drafts,
    missingNames,
    normalizedSecrets,
    onSaved,
    projectId,
    saving,
    showStatus,
  ]);

  if (normalizedSecrets.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      <Text as="div" variant="caption" tone="muted" className="text-xxs">
        Add secrets here. Values are saved to Project Secrets (not chat).
      </Text>
      <div className="space-y-2">
        {normalizedSecrets.map((secret, index) => {
          const draft = drafts[secret.name] ?? createDefaultDraft();
          const savedAt = savedAtByName[secret.name];
          const recentlySaved = typeof savedAt === "number" && Date.now() - savedAt < 60_000;
          const hasValue = Boolean(draft.value.trim());
          return (
            <Field key={secret.name} label={secret.name} htmlFor={`${fieldId}-${index}`}
              size="xs" labelClassName="font-mono" hint={secret.description || undefined}>
              <div className="flex items-stretch gap-2">
                <Input id={`${fieldId}-${index}`}
                  value={draft.value}
                  onChange={(event) => setDraftValue(secret.name, event.target.value)}
                  placeholder="Paste value…"
                  type="text"
                  size="sm"
                  radius="xl"
                  disabled={!projectId || saving}
                  // Keep this as text input + CSS masking so password managers
                  // don't treat tokens like login forms.
                  className={`min-w-0 ${draft.visible ? "" : "[-webkit-text-security:disc]"}`}
                  name={`secret-${secret.name}`}
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <IconButton
                  variant="outline"
                  size="sm"
                  radius="full"
                  aria-label={draft.visible ? "Hide value" : "Show value"}
                  onPress={() => toggleDraftVisible(secret.name)}
                  isDisabled={!projectId || saving}
                  className="shrink-0"
                >
                  {draft.visible ? (
                    <EyeClosed className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </IconButton>
              </div>
              {recentlySaved ? <Badge tone="success" size="xs" className="self-start">Saved</Badge>
                : hasValue ? <Badge tone="info" size="xs" className="self-start">Ready to save</Badge> : null}
            </Field>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          onPress={() => void handleSave()}
          variant="primary"
          size="xs"
          radius="xl"
          isDisabled={!canSave}
        >
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Spinner aria-hidden="true" tone="slate" size="xs" />
              Saving…
            </span>
          ) : (
            "Save secrets"
          )}
        </Button>
      </div>
    </div>
  );
}
