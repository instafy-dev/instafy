import { useEffect, useRef, useState } from "react";
import { SPACE_COLORS, SPACE_ICONS, normalizeSpaceColor, normalizeSpaceIcon, type ProjectIdentity, type SpaceColor, type SpaceIcon } from "@instafy/sdk/project-identity";
import { Button } from "../../../components/Button";
import { SpaceIdentity } from "../../../components/SpaceIdentity";
import { controllerClient } from "../../../sdk/instafy";
import { useWorkspaceStore } from "../../../store";
import { PROJECT_ACCESS_REFRESH_EVENT } from "../../../projects/projectAccessEvents";
import { SettingsSection } from "./SettingsSection";
import { SettingsSurface } from "./SettingsSurface";

const ICON_NAMES = ["Rocket", "Tools", "Idea", "Seedling", "Art", "Books", "Science", "Target", "World", "Lightning", "Home", "Puzzle"];

export function SpaceIdentityEditor({ projectId, name, canWrite, enabled }: {
  projectId: string;
  name: string | null;
  canWrite: boolean;
  enabled: boolean;
}) {
  const [saved, setSaved] = useState<ProjectIdentity>(() => useWorkspaceStore.getState().projects[projectId]?.metadata ?? {});
  const [icon, setIcon] = useState<SpaceIcon | null>(normalizeSpaceIcon(saved.projectIcon));
  const [color, setColor] = useState<SpaceColor | null>(normalizeSpaceColor(saved.projectColor));
  const [loading, setLoading] = useState(enabled);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (enabled) {
      setLoading(true);
      setLoadFailed(false);
      setError(null);
      void controllerClient.projects.getSummary(projectId).then((summary) => {
        if (!active) return;
        if (!summary) throw new Error("Unable to load space appearance.");
        const identity = { projectIcon: normalizeSpaceIcon(summary.projectIcon), projectColor: normalizeSpaceColor(summary.projectColor) };
        setSaved(identity);
        setIcon(identity.projectIcon);
        setColor(identity.projectColor);
        useWorkspaceStore.getState().setProjectIdentity(projectId, identity);
      }).catch(() => {
        if (active) {
          setLoadFailed(true);
          setError("Unable to load space appearance.");
        }
      }).finally(() => {
        if (active) setLoading(false);
      });
    }
    return () => { active = false; mounted.current = false; };
  }, [enabled, projectId, loadAttempt]);

  const dirty = icon !== normalizeSpaceIcon(saved.projectIcon) || color !== normalizeSpaceColor(saved.projectColor);
  const disabled = !canWrite || !enabled || loading || loadFailed || saving;
  const save = async () => {
    if (disabled || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const summary = await controllerClient.projects.updateIdentity({ projectId, projectIcon: icon, projectColor: color });
      if (!summary) throw new Error("Unable to save space appearance. Try again.");
      const identity = { projectIcon: normalizeSpaceIcon(summary.projectIcon), projectColor: normalizeSpaceColor(summary.projectColor) };
      useWorkspaceStore.getState().setProjectIdentity(projectId, identity);
      window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, { detail: { projectId } }));
      if (mounted.current) {
        setSaved(identity);
        setIcon(identity.projectIcon);
        setColor(identity.projectColor);
        setNotice("Space appearance saved.");
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to save space appearance. Try again.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return <SettingsSection title="Space appearance" description="Choose an icon and color to recognize this space in your team." data-testid="space-identity-editor">
    <SettingsSurface>
      <div className="flex items-center gap-3"><SpaceIdentity name={name} icon={icon} color={color} className="h-10 w-10 text-xl" /><span className="truncate text-sm font-medium">{name || "Untitled space"}</span></div>
      <fieldset disabled={disabled} className="mt-4">
        <legend className="text-xs font-medium">Icon</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={icon === null} onClick={() => setIcon(null)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700">Default icon</button>
          {SPACE_ICONS.map((value, index) => <button key={value} type="button" aria-label={ICON_NAMES[index]} aria-pressed={icon === value} onClick={() => setIcon(value)} className={`h-9 w-9 rounded-lg border text-lg disabled:opacity-50 ${icon === value ? "border-primary-500 bg-primary-50 dark:bg-primary-950" : "border-slate-200 dark:border-slate-700"}`}>{value}</button>)}
        </div>
      </fieldset>
      <fieldset disabled={disabled} className="mt-4">
        <legend className="text-xs font-medium">Color</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={color === null} onClick={() => setColor(null)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700">Default color</button>
          {SPACE_COLORS.map((value) => <button key={value} type="button" aria-label={`${value[0].toUpperCase()}${value.slice(1)} color`} aria-pressed={color === value} onClick={() => setColor(value)} className={`rounded-lg border p-0.5 disabled:opacity-50 ${color === value ? "border-primary-500 ring-1 ring-primary-500" : "border-transparent"}`}><SpaceIdentity name={name} icon={icon} color={value} /></button>)}
        </div>
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onPress={() => void save()} isDisabled={disabled || !dirty} variant="outline" size="sm" data-testid="space-identity-save">{saving ? "Saving…" : "Save appearance"}</Button>
        <Button onPress={() => { setIcon(null); setColor(null); }} isDisabled={disabled || (icon === null && color === null)} variant="ghost" size="sm">Clear appearance</Button>
        <Button onPress={() => { setIcon(normalizeSpaceIcon(saved.projectIcon)); setColor(normalizeSpaceColor(saved.projectColor)); setError(null); }} isDisabled={disabled || !dirty} variant="ghost" size="sm">Cancel</Button>
      </div>
      {loading ? <p role="status" className="mt-2 text-xs text-slate-500">Loading appearance…</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}
      {loadFailed ? <Button onPress={() => setLoadAttempt((value) => value + 1)} variant="ghost" size="sm">Retry</Button> : null}
      {notice && !dirty ? <p role="status" className="mt-2 text-xs text-slate-500">{notice}</p> : null}
    </SettingsSurface>
  </SettingsSection>;
}
