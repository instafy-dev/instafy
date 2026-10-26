import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { InlineNotice } from "../../../components/InlineNotice";
import { Input } from "../../../components/Input";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { SettingsFormActions } from "../../../components/SettingsFormActions";
import { Text } from "../../../components/Text";
import {
  loadNativeSubagentSettings,
  saveNativeSubagentSettings,
  type NativeSubagentSettings as Settings,
} from "../../../services/runtimeController/nativeSubagentSettings";
import { useStudioDraftState, useStudioNavigationProtection } from "../../../workspace/StudioDrafts";
import { SettingsSection } from "./SettingsSection";

export function NativeSubagentSettings({ projectId }: { projectId: string }) {
  return <NativeSubagentSettingsForm key={projectId} projectId={projectId} />;
}

function NativeSubagentSettingsForm({ projectId }: { projectId: string }) {
  const id = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const mounted = useRef(false);
  const [draft, setDraft] = useStudioDraftState(`space:${projectId}:native-subagents`, String(settings?.maxNativeSubagents ?? ""), !loading);
  useStudioNavigationProtection(saving, "AI helper settings save");

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setLoading(true);
    setError(null);
    void loadNativeSubagentSettings(projectId).then(value => {
      if (active) setSettings(value);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : "Unable to load AI helper settings.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; mounted.current = false; };
  }, [projectId, attempt]);

  const bounds = settings?.limits?.maxNativeSubagents;
  const supported = settings?.maxNativeSubagents !== undefined && bounds !== undefined;
  const value = Number(draft);
  const invalid = !draft.trim() || !Number.isInteger(value) || !bounds || value < bounds.min || value > bounds.max;
  const dirty = draft !== String(settings?.maxNativeSubagents ?? "");
  const disabled = loading || saving || !settings?.canManage || !supported;
  const cancel = () => { setDraft(String(settings?.maxNativeSubagents ?? "")); setError(null); setSavedNotice(false); };
  const save = async () => {
    if (disabled || invalid || !dirty) return;
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      const updated = await saveNativeSubagentSettings(projectId, value);
      if (mounted.current) {
        setSettings(updated);
        setDraft(String(updated.maxNativeSubagents ?? ""));
        setSavedNotice(true);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to save AI helper settings.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return <SettingsSection title="AI helpers" description="Let an agent work with several native helpers on one task." data-testid="native-subagent-settings">
    {loading ? <LoadingStatus>Loading helper settings…</LoadingStatus> : supported ? (
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <Field label="Concurrent helpers per task" htmlFor={id}
          hint="Excludes the parent agent. Shared team workers have a separate limit."
          error={dirty && invalid ? `Enter a whole number from ${bounds.min} to ${bounds.max}.` : null}>
          <Input id={id} type="number" min={bounds.min} max={bounds.max} step={1} value={draft}
            disabled={disabled} aria-invalid={dirty && invalid || undefined}
            onChange={event => { setDraft(event.target.value); setSavedNotice(false); }}
            onKeyDown={event => { if (event.key === "Escape" && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); } }}
            data-testid="native-subagent-limit" />
        </Field>
        <Text variant="caption" tone="muted">Applies to new tasks and follow-ups. Tasks already running keep their current limit. More helpers can increase AI usage.</Text>
        {settings?.canManage ? <SettingsFormActions saveLabel="Save helper limit" saving={saving} disabled={disabled || invalid || !dirty}
          onCancel={cancel} cancelDisabled={disabled || !dirty} saveTestId="native-subagent-save" /> :
          <Text variant="caption" tone="muted">Only space managers can change this limit.</Text>}
      </form>
    ) : settings ? <Text variant="caption" tone="muted">This controller version does not support configuring native helpers.</Text> : null}
    {error ? <InlineNotice tone="danger" role="alert" actions={!settings && !loading ?
      <Button preset="inline" variant="text" onPress={() => setAttempt(value => value + 1)}>Retry</Button> : undefined}>{error}</InlineNotice> : null}
    {savedNotice && !dirty ? <Text variant="caption" tone="muted" role="status">Helper limit saved.</Text> : null}
  </SettingsSection>;
}
