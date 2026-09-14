import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { SettingsFormLayout } from "../../../components/SettingsFormLayout";
import { OrgIdentity } from "../../../components/OrgIdentity";
import { updateControllerOrganization, type ControllerOrgSummary } from "../../../services/runtimeController/projects";
import { OrgAvatarEditor } from "./OrgAvatarEditor";
import { SettingsSection } from "./SettingsSection";
import { TeamAccentPicker } from "./TeamAccentPicker";
import { normalizeOrgAccent, type OrgAccent } from "../../../org/orgAccent";
import { notifyTeamProfileUpdated } from "./teamAvatar";

type TeamProfileSettingsProps = {
  organization: ControllerOrgSummary;
  role: string | null;
  onCreateSpace?: (organizationId: string) => void;
};

export function TeamProfileSettings(props: TeamProfileSettingsProps) {
  return <TeamProfileForm key={props.organization.id} {...props} />;
}

function TeamProfileForm({ organization, role, onCreateSpace }: TeamProfileSettingsProps) {
  const [name, setName] = useState(organization.name);
  const [savedName, setSavedName] = useState(organization.name);
  const [color, setColor] = useState<OrgAccent | null>(normalizeOrgAccent(organization.accentColor));
  const [savedColor, setSavedColor] = useState(color);
  const previousServerColor = useRef(color);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const previousServerName = useRef(organization.name);
  const canEdit = role === "owner" || role === "admin";
  useEffect(() => {
    // Refreshes after a picture change must not discard an unfinished name edit.
    const previous = previousServerName.current;
    setName((current) => current === previous ? organization.name : current);
    setSavedName(organization.name);
    previousServerName.current = organization.name;
  }, [organization.name]);
  useEffect(() => {
    const incoming = normalizeOrgAccent(organization.accentColor);
    const previous = previousServerColor.current;
    setColor(current => current === previous ? incoming : current);
    setSavedColor(incoming);
    previousServerColor.current = incoming;
  }, [organization.accentColor]);
  const changed = name.trim() !== savedName || color !== savedColor;
  const saveProfile = async () => {
    if (!canEdit || pending || !name.trim() || !changed) return;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      if (!await updateControllerOrganization(organization.id, { ...(name.trim() !== savedName ? { name: name.trim() } : {}), ...(color !== savedColor ? { accentColor: color } : {}) })) {
        throw new Error("Team profile could not be saved. Check your connection and try again.");
      }
      setSavedName(name.trim());
      setSavedColor(color);
      setSaved(true);
      notifyTeamProfileUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the team profile.");
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsFormLayout>
      <SettingsSection title="Team profile" description="Choose the name, picture and color people see when they select this team."
        data-testid="org-settings-profile">
        <div className="space-y-5">
          <div className="space-y-2">
            <Text variant="caption" tone="muted">Team picture</Text>
            <OrgAvatarEditor orgId={organization.id} orgName={name} accentColor={color}
              avatarUrl={organization.avatarUrl ?? null} canEdit={canEdit} />
          </div>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}>
            <Field label="Team name" htmlFor="team-profile-name">
              <Input id="team-profile-name" value={name} maxLength={120} disabled={!canEdit || pending}
                onChange={(event) => { setName(event.target.value); setSaved(false); }} data-testid="team-profile-name" />
            </Field>
            <TeamAccentPicker value={color} disabled={!canEdit || pending} onChange={value => { setColor(value); setSaved(false); }} />
            <figure className="space-y-1">
              <figcaption className="text-xs text-slate-500 dark:text-slate-400">Selector preview</figcaption>
              <div className="org-accent-chip inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm" data-org-accent={color ?? "slate"}>
                <OrgIdentity name={name} avatarUrl={organization.avatarUrl} accentColor={color} className="h-6 w-6 text-[11px]" />
                <span className="truncate">{name.trim() || "Team name"}</span>
              </div>
            </figure>
            {canEdit ? <Button type="submit" variant="outline" size="sm" radius="xl"
              isDisabled={pending || !name.trim() || !changed}
              data-testid="team-profile-save">{pending ? "Saving…" : "Save profile"}</Button> : null}
            {error ? <Text as="p" role="alert" variant="body" tone="danger">{error}</Text> : null}
            {saved ? <Text as="p" role="status" variant="caption" tone="muted">Team profile saved.</Text> : null}
          </form>
          {!canEdit ? <Text as="p" variant="body" tone="muted" data-testid="team-profile-role-hint">
            {role === "builder" ? "You're a Builder in this team. " : role === "viewer" ? "You're a Viewer in this team. " : ""}
            Only owners and admins can change the team name, picture and color.
          </Text> : null}
          {onCreateSpace && (canEdit || role === "builder") ? (
            <div className="space-y-2">
              <Text as="p" variant="body" tone="muted">Create a space in this team to start working together.</Text>
              <Button type="button" variant="primary" size="sm" radius="xl"
                data-testid="team-profile-create-space" onPress={() => onCreateSpace(organization.id)}>New space</Button>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsFormLayout>
  );
}
