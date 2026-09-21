import { useStudioDraftState, useStudioNavigationProtection } from "../../../workspace/StudioDrafts";
import { IdentityPhotoButton } from "../../../components/IdentityPhotoButton";
import { IDENTITY_IMAGE_ACCEPT, uploadIdentityImage, validateIdentityImage } from "../../../lib/identityImages";
import { useEffect, useRef, useState } from "react";
import { SPACE_COLORS, SPACE_ICONS, normalizeSpaceAvatarUrl, normalizeSpaceColor, normalizeSpaceIcon, type ProjectIdentity, type SpaceColor, type SpaceIcon } from "@instafy/sdk/project-identity";
import { Button } from "../../../components/Button";
import { SpaceIdentity } from "../../../components/SpaceIdentity";
import { controllerClient } from "../../../sdk/instafy";
import { useWorkspaceStore } from "../../../store";
import { PROJECT_ACCESS_REFRESH_EVENT } from "../../../projects/projectAccessEvents";
import { SettingsSection } from "./SettingsSection";
import { SettingsFormActions } from "../../../components/SettingsFormActions";

const ICON_NAMES = ["Rocket", "Tools", "Idea", "Seedling", "Art", "Books", "Science", "Target", "World", "Lightning", "Home", "Puzzle"];

type SpaceIdentityEditorProps = {
  projectId: string;
  name: string | null;
  canWrite: boolean;
  enabled: boolean;
};
export function SpaceIdentityEditor(props: SpaceIdentityEditorProps) {
  return <SpaceIdentityForm key={props.projectId} {...props} />;
}
function SpaceIdentityForm({ projectId, name, canWrite, enabled }: SpaceIdentityEditorProps) {
  const [saved, setSaved] = useState<ProjectIdentity>(() => useWorkspaceStore.getState().projects[projectId]?.metadata ?? {});
  const [loading, setLoading] = useState(enabled);
  const [icon, setIcon] = useStudioDraftState<SpaceIcon | null>(`space:${projectId}:icon`, normalizeSpaceIcon(saved.projectIcon), !loading);
  const [color, setColor] = useStudioDraftState<SpaceColor | null>(`space:${projectId}:color`, normalizeSpaceColor(saved.projectColor), !loading);
  const [avatarUrl, setAvatarUrl] = useStudioDraftState<string | null>(`space:${projectId}:avatar`, normalizeSpaceAvatarUrl(saved.projectAvatarUrl), !loading);
  const [imageFile, setImageFile] = useStudioDraftState<File | null>(`space:${projectId}:file`, null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = imageFile ? URL.createObjectURL(imageFile) : null;
    setPreviewUrl(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [imageFile]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  useStudioNavigationProtection(saving, "space appearance save");
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
        const identity = { projectIcon: normalizeSpaceIcon(summary.projectIcon), projectColor: normalizeSpaceColor(summary.projectColor), projectAvatarUrl: normalizeSpaceAvatarUrl(summary.projectAvatarUrl) };
        setSaved(identity);
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

  const dirty = imageFile !== null || avatarUrl !== normalizeSpaceAvatarUrl(saved.projectAvatarUrl) || icon !== normalizeSpaceIcon(saved.projectIcon) || color !== normalizeSpaceColor(saved.projectColor);
  const disabled = !canWrite || !enabled || loading || loadFailed || saving;
  const save = async () => {
    if (disabled || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const image = imageFile ? await uploadIdentityImage("spaces", projectId, imageFile) : avatarUrl;
      const summary = await controllerClient.projects.updateIdentity({ projectId, projectIcon: icon, projectColor: color,
        ...(image !== normalizeSpaceAvatarUrl(saved.projectAvatarUrl) ? { projectAvatarUrl: image } : {}) });
      if (!summary) throw new Error("Unable to save space appearance. Try again.");
      const identity = { projectIcon: normalizeSpaceIcon(summary.projectIcon), projectColor: normalizeSpaceColor(summary.projectColor), projectAvatarUrl: normalizeSpaceAvatarUrl(summary.projectAvatarUrl) };
      useWorkspaceStore.getState().setProjectIdentity(projectId, identity);
      window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, { detail: { projectId } }));
      if (mounted.current) {
        setSaved(identity);
        setIcon(identity.projectIcon);
        setColor(identity.projectColor);
        setAvatarUrl(identity.projectAvatarUrl);
        setImageFile(null);
        setNotice("Space appearance saved.");
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to save space appearance. Try again.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return <SettingsSection title="Space appearance" description="Choose a picture, icon and color to recognize this space in your team." data-testid="space-identity-editor">
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        {canWrite ? <IdentityPhotoButton square accept={IDENTITY_IMAGE_ACCEPT} disabled={disabled}
          label={previewUrl || avatarUrl ? "Change space picture" : "Upload space picture"}
          testId="space-avatar-change" inputTestId="space-avatar-file-input"
          onSelect={file => {
            const invalid = validateIdentityImage(file);
            if (invalid) { setError(invalid); return; }
            setError(null); setNotice(null); setImageFile(file);
          }}>
          <SpaceIdentity name={name} icon={icon} color={color} avatarUrl={previewUrl ?? avatarUrl} className="!h-16 !w-16 !text-2xl" />
        </IdentityPhotoButton> : <SpaceIdentity name={name} icon={icon} color={color} avatarUrl={avatarUrl} className="!h-16 !w-16 !text-2xl" />}
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-medium">{name || "Untitled space"}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">PNG, JPEG or WebP, up to 2 MB.</p>
          {canWrite && (imageFile || avatarUrl) ? <Button variant="ghost" size="sm" isDisabled={disabled}
            onPress={() => { setAvatarUrl(null); setImageFile(null); setNotice(null); }} data-testid="space-avatar-remove">Remove picture</Button> : null}
        </div>
      </div>
      <fieldset disabled={disabled} className="mt-4">
        <legend className="text-xs font-medium">{imageFile || avatarUrl ? "Fallback icon" : "Icon"}</legend>
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
      <SettingsFormActions saveLabel="Save appearance" onSave={() => void save()} saving={saving}
        disabled={disabled || !dirty} saveTestId="space-identity-save"
        onCancel={() => { setIcon(normalizeSpaceIcon(saved.projectIcon)); setColor(normalizeSpaceColor(saved.projectColor)); setAvatarUrl(normalizeSpaceAvatarUrl(saved.projectAvatarUrl)); setImageFile(null); setError(null); }}
        cancelDisabled={disabled || !dirty}
        secondary={<Button onPress={() => { setIcon(null); setColor(null); setAvatarUrl(null); setImageFile(null); }} isDisabled={disabled || (icon === null && color === null && !avatarUrl && !imageFile)} variant="ghost" size="sm" radius="xl" className="min-h-11 sm:pointer-fine:min-h-9">Clear appearance</Button>} />
      {loading ? <p role="status" className="mt-2 text-xs text-slate-500">Loading appearance…</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}
      {loadFailed ? <Button onPress={() => setLoadAttempt((value) => value + 1)} variant="ghost" size="sm">Retry</Button> : null}
      {notice && !dirty ? <p role="status" className="mt-2 text-xs text-slate-500">{notice}</p> : null}
    </div>
  </SettingsSection>;
}
