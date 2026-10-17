import { useId } from "react";
import { Field } from "../../../components/Field";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { Spinner } from "../../../components/Spinner";
import { Toggle } from "../../../components/Toggle";
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { MobileFocusDialog } from "../../../components/aria/MobileFocusDialog";
import { useBreakpoint } from "../../../hooks/useBreakpoint";

type SkillsImportModalProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  importPending: boolean;
  importSource: string;
  onImportSourceChange: (value: string) => void;
  importName: string;
  onImportNameChange: (value: string) => void;
  importOverwrite: boolean;
  onImportOverwriteChange: (nextSelected: boolean) => void;
  hasProject: boolean;
  workspaceUnavailable?: boolean;
  /** Opens the shared tool chooser. The host guards and dismisses this import first. */
  onBrowseSkills?: () => void;
  onSubmitImport: () => void;
};

// Reached from "Import custom skill" in the tool chooser or Skills. Its
// "Add and start" button is the only control here that sends.
export function SkillsImportModal({
  isOpen,
  onOpenChange,
  importPending,
  importSource,
  onImportSourceChange,
  importName,
  onImportNameChange,
  importOverwrite,
  onImportOverwriteChange,
  hasProject,
  workspaceUnavailable = false,
  onBrowseSkills,
  onSubmitImport,
}: SkillsImportModalProps) {
  const fieldId = useId();
  const isDesktop = useBreakpoint("sm", { freeze: isOpen });
  const changeOpen = (open: boolean) => { if (open || !importPending) onOpenChange(open); };
  const form = (
      <StudioDialogBody scrollable={isDesktop} className="space-y-4">
        <Text variant="bodyCompact" tone="secondary">
          Paste a GitHub repo or skill folder link, a SKILL.md link, or a workspace path.
          Every skill in it installs and its setup starts in chat.
        </Text>
        {workspaceUnavailable ? (
          <Text as="p" variant="caption" tone="muted" role="status">
            Workspace files are unavailable. Your draft is kept; reconnect before adding this skill.
          </Text>
        ) : null}
        <Field label="Source" htmlFor={`${fieldId}-skills-import-source`}>
          <Input autoFocus id={`${fieldId}-skills-import-source`}
            value={importSource}
            onChange={(event) => onImportSourceChange(event.target.value)}
            placeholder="https://github.com/owner/repo or a skill folder link"
            disabled={importPending}
            data-testid="skills-import-source"
          />
        </Field>

        <Field label="Optional skill name" htmlFor={`${fieldId}-skills-import-name`} hint="Single-skill sources only">
          <Input id={`${fieldId}-skills-import-name`}
            value={importName}
            onChange={(event) => onImportNameChange(event.target.value)}
            placeholder="playwright-review"
            disabled={importPending}
            data-testid="skills-import-name"
          />
        </Field>

        <Toggle
          size="sm"
          isSelected={importOverwrite}
          onChange={onImportOverwriteChange}
          isDisabled={importPending}
          label="Allow overwrite if the skill exists"
          description="Use with caution when reinstalling an existing skill."
          data-testid="skills-import-overwrite"
        />

      </StudioDialogBody>
  );
  const actions = (
        <StudioDialogFooter padding="default" divider className="flex flex-wrap items-center justify-between gap-2">
          {onBrowseSkills ? (
            <Button
              variant="ghost"
              size="sm"
              radius="xl"
              onPress={onBrowseSkills}
              isDisabled={importPending}
              data-testid="skills-browse"
            >
              Browse tools
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              radius="xl"
              onPress={() => changeOpen(false)}
              isDisabled={importPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              onPress={onSubmitImport}
              isDisabled={!hasProject || workspaceUnavailable || importPending || !importSource.trim()}
              data-testid="skills-import-submit"
            >
              {importPending ? <Spinner tone="primary" size="sm" aria-hidden="true" /> : null}
              Add and start
            </Button>
          </div>
        </StudioDialogFooter>
  );

  if (!isDesktop) {
    return <MobileFocusDialog isOpen={isOpen} onOpenChange={changeOpen}
      dialogAriaLabel="Import custom skill" closeDisabled={importPending}
      footer={actions} gutter="responsive" data-testid="skills-add-modal">
      {form}
    </MobileFocusDialog>;
  }

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={changeOpen}
      isDismissable={!importPending}
      isKeyboardDismissDisabled={importPending}
      dialogAriaLabel="Import custom skill"
      layout="editor"
      gutter="responsive"
      data-testid="skills-add-modal"
    >
      <StudioDialogHeader title="Import custom skill" onClose={() => changeOpen(false)}
        closeLabel="Close" closeButtonDisabled={importPending} />
      {form}
      {actions}
    </StudioDialogModal>
  );
}
