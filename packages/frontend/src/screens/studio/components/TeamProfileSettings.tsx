import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { SettingsFormLayout } from "../../../components/SettingsFormLayout";
import { updateControllerOrganization, type ControllerOrgSummary } from "../../../services/runtimeController/projects";
import { OrgAvatarEditor } from "./OrgAvatarEditor";
import { SettingsSection } from "./SettingsSection";
import { notifyTeamProfileUpdated } from "./teamAvatar";

export function TeamProfileSettings({ organization, role, onCreateSpace }: {
  organization: ControllerOrgSummary;
  role: string | null;
  onCreateSpace?: (organizationId: string) => void;
}) {
  const [name, setName] = useState(organization.name);
  const [savedName, setSavedName] = useState(organization.name);
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
  const saveName = async () => {
    if (!canEdit || pending || !name.trim() || name.trim() === savedName) return;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      if (!await updateControllerOrganization(organization.id, { name: name.trim() })) {
        throw new Error("Team name could not be saved. Check your connection and try again.");
      }
      setSavedName(name.trim());
      setSaved(true);
      notifyTeamProfileUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the team name.");
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsFormLayout>
      <SettingsSection title="Team profile" description="Choose the name and picture people see when they select this team."
        data-testid="org-settings-profile">
        <div className="space-y-5">
          <div className="space-y-2">
            <Text variant="caption" tone="muted">Team picture</Text>
            <OrgAvatarEditor orgId={organization.id} orgName={organization.name}
              avatarUrl={organization.avatarUrl ?? null} canEdit={canEdit} />
          </div>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
            <Field label="Team name" htmlFor="team-profile-name">
              <Input id="team-profile-name" value={name} maxLength={120} disabled={!canEdit || pending}
                onChange={(event) => { setName(event.target.value); setSaved(false); }} data-testid="team-profile-name" />
            </Field>
            {canEdit ? <Button type="submit" variant="outline" size="sm" radius="xl"
              isDisabled={pending || !name.trim() || name.trim() === savedName}
              data-testid="team-profile-save">{pending ? "Saving…" : "Save name"}</Button> : null}
            {error ? <Text as="p" role="alert" variant="body" tone="danger">{error}</Text> : null}
            {saved ? <Text as="p" role="status" variant="caption" tone="muted">Team name saved.</Text> : null}
          </form>
          {!canEdit ? <Text as="p" variant="body" tone="muted" data-testid="team-profile-role-hint">
            {role === "builder" ? "You're a Builder in this team. " : role === "viewer" ? "You're a Viewer in this team. " : ""}
            Only owners and admins can change the team name and picture.
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
