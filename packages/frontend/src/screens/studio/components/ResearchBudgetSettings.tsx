import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { InlineNotice } from "../../../components/InlineNotice";
import { Input } from "../../../components/Input";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { SettingsFormActions } from "../../../components/SettingsFormActions";
import { Text } from "../../../components/Text";
import { loadResearchSettings, saveResearchSettings, type ResearchSettings } from "../../../services/runtimeController/researchSettings";
import { useStudioDraftState, useStudioNavigationProtection } from "../../../workspace/StudioDrafts";
import { SettingsSection } from "./SettingsSection";

const fields = [
  { key: "maxPageLoads", label: "Fresh pages per task" },
  { key: "maxPageLoadsPerSite", label: "Fresh pages per site" },
] as const;
const draftOf = (settings: ResearchSettings | null) => ({
  maxPageLoads: String(settings?.maxPageLoads ?? ""),
  maxPageLoadsPerSite: String(settings?.maxPageLoadsPerSite ?? ""),
});

export function ResearchBudgetSettings({ projectId }: { projectId: string }) {
  return <ResearchBudgetForm key={projectId} projectId={projectId} />;
}

function ResearchBudgetForm({ projectId }: { projectId: string }) {
  const id = useId();
  const [settings, setSettings] = useState<ResearchSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const mounted = useRef(false);
  const [totalDraft, setTotalDraft] = useStudioDraftState(`space:${projectId}:research-total`, String(settings?.maxPageLoads ?? ""), !loading);
  const [siteDraft, setSiteDraft] = useStudioDraftState(`space:${projectId}:research-site`, String(settings?.maxPageLoadsPerSite ?? ""), !loading);
  const draft = { maxPageLoads: totalDraft, maxPageLoadsPerSite: siteDraft };
  const setDraft = (next: typeof draft) => { setTotalDraft(next.maxPageLoads); setSiteDraft(next.maxPageLoadsPerSite); };
  useStudioNavigationProtection(saving, "Research budget save");

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setLoading(true); setError(null);
    void loadResearchSettings(projectId).then(value => {
      if (active) setSettings(value);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : "Unable to load research settings.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [projectId, attempt]);

  const supported = settings && fields.every(({ key }) => settings[key] !== undefined && settings.limits?.[key]);
  const errors = Object.fromEntries(fields.map(({ key }) => {
    const value = Number(draft[key]);
    const bounds = settings?.limits?.[key];
    return [key, !draft[key].trim() || !Number.isInteger(value) || !bounds || value < bounds.min || value > bounds.max
      ? bounds ? `Enter a whole number from ${bounds.min} to ${bounds.max}.` : "Budget settings unavailable." : null];
  }));
  if (!errors.maxPageLoads && !errors.maxPageLoadsPerSite && Number(draft.maxPageLoadsPerSite) > Number(draft.maxPageLoads)) {
    errors.maxPageLoadsPerSite = "The per-site limit cannot exceed the task limit.";
  }
  const invalid = fields.some(({ key }) => errors[key]);
  const dirty = fields.some(({ key }) => draft[key] !== String(settings?.[key] ?? ""));
  const disabled = loading || saving || !settings?.canManage || !supported;
  const cancel = () => { setDraft(draftOf(settings)); setError(null); setSavedNotice(false); };
  const save = async () => {
    if (disabled || invalid || !dirty) return;
    setSaving(true); setError(null); setSavedNotice(false);
    try {
      const updated = await saveResearchSettings(projectId, {
        maxPageLoads: Number(draft.maxPageLoads), maxPageLoadsPerSite: Number(draft.maxPageLoadsPerSite),
      });
      if (mounted.current) { setSettings(updated); setDraft(draftOf(updated)); setSavedNotice(true); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to save research settings.");
    } finally { if (mounted.current) setSaving(false); }
  };

  return <SettingsSection title="Web research" description="Set how many public pages an agent and its helpers can read for one task." data-testid="research-budget-settings">
    {loading ? <LoadingStatus>Loading research settings…</LoadingStatus> : supported ? (
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        {fields.map(({ key, label }) => <Field key={key} label={label} htmlFor={`${id}-${key}`} error={dirty ? errors[key] : null}>
          <Input id={`${id}-${key}`} type="number" min={settings.limits[key].min} max={settings.limits[key].max} step={1}
            value={draft[key]} disabled={disabled} aria-invalid={dirty && !!errors[key] || undefined}
            data-testid={`research-${key}`}
            onChange={event => { setDraft({ ...draft, [key]: event.target.value }); setSavedNotice(false); }}
            onKeyDown={event => { if (event.key === "Escape" && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); } }} />
        </Field>)}
        <Text variant="caption" tone="muted">Shared across all helpers. Cached pages do not spend this allowance. Changes apply to new tasks; running tasks and their continued workers keep their budget. Larger budgets may increase research time and AI usage.</Text>
        {settings.canManage ? <SettingsFormActions saveLabel="Save research budget" saving={saving}
          disabled={disabled || invalid || !dirty} onCancel={cancel} cancelDisabled={disabled || !dirty} saveTestId="research-budget-save" /> :
          <Text variant="caption" tone="muted">Only space managers can change this budget.</Text>}
      </form>
    ) : settings ? <Text variant="caption" tone="muted">This controller version does not support research budgets.</Text> : null}
    {error ? <InlineNotice tone="danger" role="alert" actions={!settings && !loading ?
      <Button preset="inline" variant="text" onPress={() => setAttempt(value => value + 1)}>Retry</Button> : undefined}>{error}</InlineNotice> : null}
    {savedNotice && !dirty ? <Text variant="caption" tone="muted" role="status">Research budget saved.</Text> : null}
  </SettingsSection>;
}
