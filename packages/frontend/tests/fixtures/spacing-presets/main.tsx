import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { MenuTrigger } from "react-aria-components";
import { Button } from "../../../src/components/Button";
import { DrawerHeader } from "../../../src/components/DrawerHeader";
import { Field } from "../../../src/components/Field";
import { FormPickerPopover, FormPickerTrigger } from "../../../src/components/FormPicker";
import { Input } from "../../../src/components/Input";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { Text } from "../../../src/components/Text";
import { StudioDialogModal } from "../../../src/components/aria/StudioModal";
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../../../src/components/aria/StudioDialogLayout";
import { StudioMenu, StudioMenuItem } from "../../../src/components/aria/StudioMenu";
import { StudioPopover } from "../../../src/components/aria/StudioPopover";
import { SkillsImportModal } from "../../../src/screens/studio/components/SkillsImportModal";
import { SettingsShell } from "../../../src/screens/studio/components/SettingsShell";
import { StudioMobileSidebarOverlay } from "../../../src/screens/studio/components/StudioMobileSidebarOverlay";
import "../../../src/styles/tailwind.css";

// Real shared shells and the production skill-import form. All actions are local;
// no account, controller, import, creation, or machine operation is called here.
function SpacingReview() {
  const [theme, setTheme] = useState("light");
  const [width, setWidth] = useState<"comfortable" | "wide">("comfortable");
  const [editor, setEditor] = useState(false);
  const [skill, setSkill] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [choice, setChoice] = useState("Current space");
  const [draft, setDraft] = useState("Navigation review");
  const [status, setStatus] = useState("Preview actions stay on this page.");
  return <main className="min-h-dvh bg-white text-slate-700 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200">
    <div className="border-b border-slate-200 px-4 py-3 dark:border-white/10">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <Text as="h1" variant="subtitleStrong" tone="primary">Spacing review</Text>
        <SegmentedControl aria-label="Preview theme" value={theme} width="fit" onChange={value => {
          setTheme(value); document.documentElement.classList.toggle("dark", value === "dark");
        }} options={[{value:"light",label:"Light"},{value:"dark",label:"Dark"}]} />
      </div>
    </div>
    <SettingsShell title="Workspace controls" titleVisibility="always" width={width} testId="spacing-page">
      <Text variant="bodyCompact" tone="secondary">Compare reading width, anchored menus, scrolling dialogs and navigation drawers.</Text>
      <SegmentedControl aria-label="Page width" value={width} onChange={value => setWidth(value as "comfortable" | "wide")} width="fit"
        options={[{value:"comfortable",label:"Readable"},{value:"wide",label:"Wide"}]} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onPress={() => setSkill(true)}>Import custom skill</Button>
        <Button variant="outline" onPress={() => setEditor(true)}>Open editor</Button>
        <Button variant="outline" onPress={() => setDrawer(true)}>Open navigation</Button>
        <MenuTrigger>
          <Button variant="ghost">Quick menu</Button>
          <StudioPopover layout="menu" placement="bottom end" data-testid="spacing-menu">
            <StudioMenu aria-label="Quick actions" onAction={key => setStatus(String(key))}>
              <StudioMenuItem id="Rename">Rename</StudioMenuItem>
              <StudioMenuItem id="Move to another space">Move to another space</StudioMenuItem>
              <StudioMenuItem id="Manage access">Manage access</StudioMenuItem>
            </StudioMenu>
          </StudioPopover>
        </MenuTrigger>
      </div>
      <div className="max-w-sm">
        <Field label="Scope" htmlFor="spacing-scope" labelId="spacing-scope-label">
          <MenuTrigger>
            <FormPickerTrigger id="spacing-scope" aria-labelledby="spacing-scope-label">{choice}</FormPickerTrigger>
            <FormPickerPopover data-testid="spacing-picker">
              <StudioMenu aria-label="Scope choices" selectionMode="single" selectedKeys={new Set([choice])} onAction={key => setChoice(String(key))}>
                <StudioMenuItem id="Current space">Current space</StudioMenuItem>
                <StudioMenuItem id="All team spaces">All team spaces</StudioMenuItem>
              </StudioMenu>
            </FormPickerPopover>
          </MenuTrigger>
        </Field>
      </div>
      <Text role="status" variant="caption" tone="muted">{status}</Text>
      <div className="space-y-4">
        {Array.from({length:4},(_,i) => <div key={i} className="space-y-1">
          <Text variant="bodyStrong" tone="primary">{["Chat navigation", "Files and changes", "Shared tools", "Team settings"][i]}</Text>
          <Text variant="bodyCompact" tone="secondary">The page stays readable as the available pane grows. Menus remain close to their trigger; long forms keep actions reachable.</Text>
        </div>)}
      </div>
    </SettingsShell>
    <SkillsImportModal isOpen={skill} onOpenChange={setSkill} importPending={false} importSource={source} onImportSourceChange={setSource}
      importName={name} onImportNameChange={setName} importOverwrite={overwrite} onImportOverwriteChange={setOverwrite} hasProject
      onBrowseSkills={() => {setSkill(false);setStatus("Browse tools preview");}} onSubmitImport={() => {setSkill(false);setStatus("Import preview only — nothing installed");}} />
    <StudioDialogModal isOpen={editor} onOpenChange={setEditor} isDismissable layout="editor" gutter="responsive" dialogAriaLabel="Workspace editor" data-testid="spacing-editor">
      <StudioDialogHeader title="Workspace editor" description="A longer form with fixed actions." onClose={() => setEditor(false)} />
      <StudioDialogBody scrollable>
        <div className="space-y-4">
          <Field label="Name" htmlFor="spacing-name"><Input id="spacing-name" value={draft} onChange={event => setDraft(event.target.value)} /></Field>
          {Array.from({length:12},(_,i) => <Text key={i} variant="bodyCompact" tone="secondary">Section {i+1}. Review the details here; the body scrolls without moving the title or the actions.</Text>)}
        </div>
      </StudioDialogBody>
      <StudioDialogFooter padding="default" className="flex justify-end gap-2">
        <Button variant="ghost" onPress={() => setEditor(false)}>Cancel</Button><Button variant="primary" onPress={() => setEditor(false)}>Save</Button>
      </StudioDialogFooter>
    </StudioDialogModal>
    {drawer ? <StudioMobileSidebarOverlay presentation="bottom" onClose={() => setDrawer(false)}>
      <div className="flex h-full min-h-0 flex-col">
        <DrawerHeader frame="rail" title="Spaces" />
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="spacing-drawer-body">
          <Text variant="bodyCompact" tone="secondary">Choose where to continue.</Text>
          {Array.from({length:14},(_,i) => <Button key={i} variant="ghost" className="w-full justify-start" onPress={() => {setStatus(`Space ${i+1} selected`);setDrawer(false);}}>Space {i+1}</Button>)}
        </div>
      </div>
    </StudioMobileSidebarOverlay> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><SpacingReview /></MemoryRouter>);
