import { Button } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
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
  /** When provided, a ghost "Browse skills" button opens the Skills panel. */
  onBrowseSkills?: () => void;
  onSubmitImport: () => void;
};

// Reached from the "Other" tile and from Settings > Skills "Import". Its
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
  onBrowseSkills,
  onSubmitImport,
}: SkillsImportModalProps) {
  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!importPending}
      data-testid="skills-add-modal"
    >
      <StudioDialogHeader
        title="Add skills"
        description="Paste a GitHub repo or skill folder link, a SKILL.md link, or a workspace path. Every skill in it installs and its setup starts in chat."
        onClose={() => onOpenChange(false)}
        closeLabel="Close"
        closeButtonDisabled={importPending}
      />

      <div className="space-y-4 px-5 py-4">
        <label className="space-y-1">
          <Text as="span" variant="caption" tone="muted">
            Source
          </Text>
          <Input
            autoFocus
            value={importSource}
            onChange={(event) => onImportSourceChange(event.target.value)}
            placeholder="https://github.com/owner/repo or a skill folder link"
            data-testid="skills-import-source"
          />
        </label>

        <label className="space-y-1">
          <Text as="span" variant="caption" tone="muted">
            Optional skill name
          </Text>
          <Input
            value={importName}
            onChange={(event) => onImportNameChange(event.target.value)}
            placeholder="playwright-review"
            data-testid="skills-import-name"
          />
          <Text as="span" variant="caption" tone="muted" className="block">
            Single-skill sources only
          </Text>
        </label>

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
          {onBrowseSkills ? (
            <Button
              variant="ghost"
              size="sm"
              radius="xl"
              onPress={onBrowseSkills}
              data-testid="skills-browse"
            >
              Browse skills
            </Button>
          ) : (
            <span />
          )}
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
              Add and start
            </Button>
          </div>
        </div>
      </div>
    </StudioDialogModal>
  );
}
