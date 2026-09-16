import { useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { StudioDialogBody, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { controllerClient, type ControllerOrgSummary } from "../../../sdk/instafy";
import { TeamAccentPicker } from "./TeamAccentPicker";
import type { OrgAccent } from "../../../org/orgAccent";
import { TeamPicturePicker } from "./TeamPicturePicker";
import { notifyTeamProfileUpdated, saveTeamAvatar } from "./teamAvatar";

export interface NewTeamDialogProps {
  open: boolean;
  onClose: () => void;
  allowCustomSlug?: boolean;
  onCreated: (organization: ControllerOrgSummary) => void;
}

export function NewTeamDialog({ open, ...props }: NewTeamDialogProps) {
  // A closed dialog discards only its form. A created team is reported before closing.
  return open ? <NewTeamDialogForm {...props} /> : null;
}

function NewTeamDialogForm({ onClose, onCreated, allowCustomSlug = false }: Omit<NewTeamDialogProps, "open">) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<OrgAccent | null>(null);
  const [slug, setSlug] = useState("");
  const nameId = allowCustomSlug ? "project-launcher-org-name-input" : "sidebar-new-team-name";
  const [file, setFile] = useState<File | null>(null);
  const [created, setCreated] = useState<ControllerOrgSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const completed = useRef(false);
  const finish = (organization: ControllerOrgSummary) => {
    if (completed.current) return;
    completed.current = true;
    onCreated(organization);
    onClose();
  };
  const close = () => {
    if (busy.current) return;
    if (created) finish(created);
    else onClose();
  };
  const submit = async () => {
    if (busy.current || !name.trim()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    let organization = created;
    try {
      if (!organization) {
        organization = await controllerClient.organizations.create({ orgName: name.trim(), ...(color ? { accentColor: color } : {}), ...(slug.trim() ? { orgSlug: slug.trim() } : {}) });
        if (!organization) throw new Error("Couldn't create the team. Try again in a moment.");
        setCreated(organization);
        notifyTeamProfileUpdated();
      }
      if (file) {
        const avatarUrl = await saveTeamAvatar(organization.id, file);
        organization = { ...organization, avatarUrl };
      }
      finish(organization);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Please try again.";
      setError(organization ? `Team created, but its picture wasn't saved. ${message}` : message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <StudioDialogModal isOpen onOpenChange={(value) => { if (!value) close(); }}
      isDismissable={!pending} isKeyboardDismissDisabled={pending} dialogAriaLabel="New team"
      data-testid="sidebar-new-team-modal" modalClassName="max-w-sm p-0">
      <StudioDialogHeader title="New team" description="A team has its own spaces, members and credits."
        onClose={close} closeLabel="Close new team" closeButtonDisabled={pending} />
      <StudioDialogBody>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <Field label="Team name" htmlFor={nameId}>
            <Input id={nameId} placeholder="Team name" value={name}
              onChange={(event) => setName(event.target.value)} autoFocus autoComplete="off" maxLength={80}
              disabled={pending || Boolean(created)} data-testid={nameId} />
          </Field>
          {allowCustomSlug ? <Field label="Team slug (optional)" htmlFor="project-launcher-org-slug-input" hint="Leave blank to use the team name.">
            <Input id="project-launcher-org-slug-input" value={slug} onChange={(event) => setSlug(event.target.value)}
              placeholder="my-team" disabled={pending || Boolean(created)} data-testid="project-launcher-org-slug-input" />
          </Field> : null}
          <TeamPicturePicker name={name} file={file} accentColor={created ? created.accentColor : color} onChange={setFile} disabled={pending} />
          <TeamAccentPicker value={created ? created.accentColor : color} onChange={setColor} disabled={pending || Boolean(created)} />
          {error ? <Text as="p" role="alert" variant="body" tone="danger">{error}</Text> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" radius="xl" onPress={close} isDisabled={pending}>
              {created ? "Continue without picture" : "Cancel"}
            </Button>
            <Button type="submit" variant="primary" size="sm" radius="xl"
              isDisabled={!name.trim() || pending} data-testid="sidebar-new-team-create">
              {pending ? (created ? "Saving picture…" : "Creating…") : created ? (file ? "Retry picture" : "Continue") : "Create team"}
            </Button>
          </div>
        </form>
      </StudioDialogBody>
    </StudioDialogModal>
  );
}
