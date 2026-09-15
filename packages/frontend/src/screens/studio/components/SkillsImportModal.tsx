import { useId } from "react";
import { Field } from "../../../components/Field";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Spinner } from "../../../components/Spinner";
import { Toggle } from "../../../components/Toggle";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";

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
  onOpenAssistant: () => void;
  onSubmitImport: () => void;
};

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
  onOpenAssistant,
  onSubmitImport,
}: SkillsImportModalProps) {
  const fieldId = useId();
  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!importPending}
      data-testid="skills-add-modal"
    >
      <StudioDialogHeader
        title="Import skill"
        description="Add from GitHub URL, direct SKILL.md URL, or local path."
        onClose={() => onOpenChange(false)}
        closeLabel="Close"
        closeButtonDisabled={importPending}
      />

      <div className="space-y-4 px-5 py-4">
        <Field label="Source" htmlFor={`${fieldId}-skills-import-source`}>
          <Input id={`${fieldId}-skills-import-source`}
            value={importSource}
            onChange={(event) => onImportSourceChange(event.target.value)}
            placeholder="https://github.com/owner/repo/tree/main/path/to/skill"
            disabled={importPending}
            data-testid="skills-import-source"
          />
        </Field>

        <Field label="Optional skill name" htmlFor={`${fieldId}-skills-import-name`}>
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

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <Button
            variant="ghost"
            size="sm"
            radius="xl"
            onPress={onOpenAssistant}
            data-testid="skills-open-assistant"
          >
            Open Assistant
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              radius="xl"
              onPress={() => onOpenChange(false)}
              isDisabled={importPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              radius="xl"
              onPress={onSubmitImport}
              isDisabled={!hasProject || importPending || !importSource.trim()}
              data-testid="skills-import-submit"
            >
              {importPending ? <Spinner tone="primary" size="sm" aria-hidden="true" /> : null}
              Import Skill
            </Button>
          </div>
        </div>
      </div>
    </StudioDialogModal>
  );
}
