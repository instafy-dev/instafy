import { IdentityPhotoButton } from "../../../components/IdentityPhotoButton";
import { IDENTITY_IMAGE_ACCEPT } from "../../../lib/identityImages";
import { OrgIdentity } from "../../../components/OrgIdentity";

/** Controlled picture preview; the enclosing team profile owns Save and Cancel. */
export function OrgAvatarEditor({ orgName, accentColor, canEdit, disabled, avatarUrl, onSelect }: {
  orgName: string;
  accentColor?: string | null;
  canEdit: boolean;
  disabled?: boolean;
  avatarUrl: string | null;
  onSelect: (file: File) => void;
}) {
  const picture = <span data-testid="org-avatar-preview"><OrgIdentity name={orgName}
    avatarUrl={avatarUrl} accentColor={accentColor} className="h-16 w-16 text-base" /></span>;
  return <div data-testid="org-avatar-editor">
    {canEdit ? <IdentityPhotoButton square disabled={disabled} accept={IDENTITY_IMAGE_ACCEPT}
      label={avatarUrl ? "Change team picture" : "Upload team picture"}
      onSelect={onSelect} testId="org-avatar-change" inputTestId="org-avatar-file-input">
      {picture}
    </IdentityPhotoButton> : picture}
  </div>;
}
