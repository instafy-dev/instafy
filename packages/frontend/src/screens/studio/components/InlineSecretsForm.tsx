import { Field } from "../../../components/Field";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { Eye, EyeClosed } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { ToggleIconButton } from "../../../components/ToggleIconButton";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { Spinner } from "../../../components/Spinner";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { describeSecretValueProblem } from "./secretValueShape";

// The field group for one or more project secrets: an input per value, the
// masking and password-manager opt-outs that keep a token out of a login vault,
// and one Save for all of them.
//
// It used to label itself as well (its own intro sentence, its own per-field
// name and description), which made sense only on the integration card, where
// one card asks for several values under a header that names a provider. On a
// single-value card every one of those labels landed under a header that had
// just said the same thing. The labelling now belongs to the host: it passes
// `namesShownByHost` when its own copy already names the value, and a `caption`
// for the one sentence under the last field.

type InlineSecretDescriptor = {
  name: string;
  description?: string | null;
  /**
   * The provider's own on-screen name for this value ("Installation access
   * token"), as the skill that asked declared it. Used for the input's
   * accessible name so a screen reader hears what the person will read in the
   * provider's UI rather than a shouted environment variable. Falls back to
   * the name.
   */
  valueLabel?: string | null;
  /**
   * False for a value that is not a credential, such as a base URL. It starts
   * unmasked, because hiding one behind dots promises a secrecy it does not
   * have and makes a typo in a URL impossible to see. Default true.
   */
  sensitive?: boolean;
  /**
   * The prefix the skill declared for the value ("ntn_"). The field shows it
   * as `ntn_…` in place of "Paste it here", which said nothing about what
   * belongs there. A bare token prefix only; anything else is ignored.
   */
  valueHint?: string | null;
};

type SecretValueDraft = {
  value: string;
  visible: boolean;
};

function normalizeSecretName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createDefaultDraft(sensitive = true): SecretValueDraft {
  return { value: "", visible: !sensitive };
}

export function InlineSecretsForm({
  projectId,
  secrets,
  description,
  agentHandles,
  onSaved,
  namesShownByHost = false,
  caption,
  saveLabel = "Save secrets",
  secondaryAction,
  actionAlign = "end",
  saveTestId,
  valueTestIdPrefix,
  errorTestId,
}: {
  projectId: string | null;
  secrets: InlineSecretDescriptor[];
  description?: string | null;
  agentHandles?: string[];
  onSaved?: (names: string[]) => void;
  /**
   * True when the host's own copy already names each value, so the per-field
   * mono name and description would repeat it. Default false keeps the
   * integration card, where one header covers several values, unchanged.
   */
  namesShownByHost?: boolean;
  /** One sentence under the last field: where the value is stored, and that it stays out of chat. */
  caption?: ReactNode;
  saveLabel?: string;
  /** Rendered next to Save, at lower weight. The host owns what it does. */
  secondaryAction?: ReactNode;
  actionAlign?: "start" | "end";
  saveTestId?: string;
  /** When set, each input gets `${valueTestIdPrefix}-${NAME}`. */
  valueTestIdPrefix?: string;
  /**
   * When set, a failed save also renders the controller's message inline under
   * the actions with this test id. The toast alone is easy to miss when the
   * consequence is an unsaved token.
   */
  errorTestId?: string;
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
        valueLabel:
          typeof secret.valueLabel === "string" && secret.valueLabel.trim().length > 0
            ? secret.valueLabel.trim()
            : null,
        sensitive: secret.sensitive !== false,
        valueHint:
          typeof secret.valueHint === "string" && /^[A-Za-z0-9_-]{2,16}$/.test(secret.valueHint)
            ? secret.valueHint
            : null,
      });
    }
    return out;
  }, [secrets]);

  const [drafts, setDrafts] = useState<Record<string, SecretValueDraft>>(() => {
    const initial: Record<string, SecretValueDraft> = {};
    for (const secret of normalizedSecrets) {
      initial[secret.name] = createDefaultDraft(secret.sensitive !== false);
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [savedAtByName, setSavedAtByName] = useState<Record<string, number>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  // Every failure path both toasts (unchanged) and keeps the message, so a
  // host that asked for an inline error can render it where the press was.
  const failSave = useCallback(
    (message: string) => {
      // A controller that answers with an empty message must still leave the
      // person something to act on.
      const resolved = message.trim() || "The value was not saved. Try again.";
      setSaveError(resolved);
      showStatus(resolved, "error", 5000);
    },
    [showStatus],
  );

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

  const problemsByName = useMemo(() => {
    const problems: Record<string, string> = {};
    for (const secret of normalizedSecrets) {
      if (!secret.sensitive) {
        continue;
      }
      const problem = describeSecretValueProblem(drafts[secret.name]?.value ?? "");
      if (problem) {
        problems[secret.name] = problem;
      }
    }
    return problems;
  }, [drafts, normalizedSecrets]);

  const canSave =
    Boolean(projectId) &&
    normalizedSecrets.length > 0 &&
    missingNames.length === 0 &&
    Object.keys(problemsByName).length === 0 &&
    !saving;

  const sensitiveByName = useMemo(
    () => new Map(normalizedSecrets.map((secret) => [secret.name, secret.sensitive])),
    [normalizedSecrets],
  );

  const setDraftValue = useCallback(
    (name: string, value: string) => {
      // Words in place of the value are named as they land, and the field
      // unmasks so they can be read: a masked sentence looks like a token.
      const unmask =
        sensitiveByName.get(name) !== false && describeSecretValueProblem(value) !== null;
      setDrafts((current) => {
        const existing = current[name] ?? createDefaultDraft();
        return {
          ...current,
          [name]: { ...existing, value, visible: unmask ? true : existing.visible },
        };
      });
    },
    [sensitiveByName],
  );

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
    // Words pasted in place of the value are caught here, before anything is
    // sent. Otherwise the agent learns it from the provider's 401 and has to
    // ask again.
    for (const secret of normalizedSecrets) {
      if (!secret.sensitive) {
        continue;
      }
      const problem = describeSecretValueProblem(drafts[secret.name]?.value ?? "");
      if (problem) {
        failSave(problem);
        return;
      }
    }

    setSaveError(null);
    setSaving(true);
    try {
      const existing = await controllerClient.secrets.listForProject(projectId);
      if (!existing.success) {
        failSave(existing.error ?? "Unable to load current secrets.");
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
            failSave(updated.error ?? `Unable to update ${secret.name}`);
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
          failSave(created.error ?? `Unable to save ${secret.name}`);
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
    failSave,
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
      <div className="space-y-2">
        {normalizedSecrets.map((secret, index) => {
          const draft = drafts[secret.name] ?? createDefaultDraft(secret.sensitive !== false);
          // The badge stays for as long as the card is on screen: a state that
          // erased itself after a minute left the person with no answer to
          // "did that save?".
          const saved = typeof savedAtByName[secret.name] === "number";
          const problem = problemsByName[secret.name] ?? null;
          return (
            <Field key={secret.name} label={namesShownByHost ? undefined : secret.name}
              htmlFor={`${fieldId}-${index}`} size="xs" labelClassName="font-mono"
              hint={namesShownByHost ? undefined : secret.description || undefined}>
              {saved ? <Badge tone="success" size="xs" className="self-start">Saved</Badge> : null}
              {/* The reveal sits inside the field, which is where every other
                  trailing control in the product sits: the login password eye,
                  the history search filter, both browser address bars. Beside
                  it, it was a bordered white box next to a bordered white box,
                  and it ate typing room the phone width does not have. */}
              <div className="relative">
                <Input id={`${fieldId}-${index}`}
                  value={draft.value}
                  onChange={(event) => setDraftValue(secret.name, event.target.value)}
                  placeholder={secret.valueHint ? `${secret.valueHint}…` : "Paste it here"}
                  aria-label={`${secret.valueLabel ?? secret.name} value`}
                  type="text"
                  size="sm"
                  radius="xl"
                  disabled={!projectId || saving}
                  {...(valueTestIdPrefix
                    ? { "data-testid": `${valueTestIdPrefix}-${secret.name.toUpperCase()}` }
                    : {})}
                  // Keep this as text input + CSS masking so password managers
                  // don't treat tokens like login forms.
                  className={`pr-12 ${draft.visible ? "" : "[-webkit-text-security:disc]"}`}
                  name={`secret-${secret.name}`}
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <ToggleIconButton
                  appearance="bare"
                  isSelected={draft.visible}
                  size="sm"
                  radius="full"
                  aria-label={draft.visible ? "Hide value" : "Show value"}
                  onPress={() => toggleDraftVisible(secret.name)}
                  isDisabled={!projectId || saving}
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                >
                  {draft.visible ? (
                    <EyeClosed className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </ToggleIconButton>
              </div>
              {problem ? (
                <Text
                  as="div"
                  variant="caption"
                  tone="inherit"
                  className="text-xxs leading-snug text-rose-600 dark:text-rose-300"
                  {...(valueTestIdPrefix
                    ? { "data-testid": `${valueTestIdPrefix}-${secret.name.toUpperCase()}-problem` }
                    : {})}
                >
                  {problem}
                </Text>
              ) : null}
            </Field>
          );
        })}
      </div>

      {caption ? (
        <Text as="div" variant="caption" tone="muted" className="text-xxs leading-snug">
          {caption}
        </Text>
      ) : null}

      <div
        className={`flex flex-wrap items-center gap-2 ${
          actionAlign === "start" ? "justify-start" : "justify-end"
        }`}
      >
        <Button
          onPress={() => void handleSave()}
          variant="primary"
          size={actionAlign === "start" ? "sm" : "xs"}
          radius="xl"
          isDisabled={!canSave}
          {...(saveTestId ? { "data-testid": saveTestId } : {})}
        >
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Spinner aria-hidden="true" tone="slate" size="xs" />
              Saving…
            </span>
          ) : (
            saveLabel
          )}
        </Button>
        {secondaryAction}
      </div>

      {errorTestId && saveError ? (
        <Text
          as="div"
          variant="caption"
          tone="inherit"
          className="text-xxs leading-snug text-rose-600 dark:text-rose-300"
          data-testid={errorTestId}
        >
          {saveError}
        </Text>
      ) : null}
    </div>
  );
}
