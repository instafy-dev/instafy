import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MoreHoriz, Plus, Trash } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Button, IconButton } from "../../../src/components/Button";
import { Checkbox } from "../../../src/components/Checkbox";
import { Field } from "../../../src/components/Field";
import { FormPickerTrigger, FormPickerPopover } from "../../../src/components/FormPicker";
import { Input } from "../../../src/components/Input";
import { Select } from "../../../src/components/Select";
import { Toggle } from "../../../src/components/Toggle";
import { Text } from "../../../src/components/Text";
import { Surface } from "../../../src/components/Surface";
import { Badge } from "../../../src/components/Badge";
import { InlineNotice } from "../../../src/components/InlineNotice";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { StudioDialogModal } from "../../../src/components/aria/StudioModal";
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../../../src/components/aria/StudioDialogLayout";
import { StudioMenu, StudioMenuItem } from "../../../src/components/aria/StudioMenu";
import "../../../src/styles/tailwind.css";

// Local-only Vite entrypoint. No app session, backend calls or product route.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Surface shadow="none" className="space-y-4 p-5">
    <Text as="h2" variant="subtitleStrong" tone="primary">{title}</Text>
    {children}
  </Surface>;
}

function ComponentReference() {
  const [theme, setTheme] = useState("light");
  const [selection, setSelection] = useState("files");
  const [checked, setChecked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [actions, setActions] = useState(0);
  const [model, setModel] = useState("Default");
  const changeTheme = (value: string) => {
    setTheme(value);
    document.documentElement.classList.toggle("dark", value === "dark");
  };
  return <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <Text as="h1" variant="title" tone="primary">Component reference</Text>
        <Text variant="body" tone="muted">Production controls, shared states and responsive sizes.</Text>
      </div>
      <SegmentedControl aria-label="Preview theme" value={theme} onChange={changeTheme} width="fit"
        options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
    </header>
    <Section title="Actions">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onPress={() => setActions(n => n + 1)} data-testid="reference-primary" icon={<Plus className="h-4 w-4" />}>Connect</Button>
        <Button variant="outline">Cancel</Button>
        <Button variant="ghost" data-testid="reference-retry">Retry</Button>
        <Button variant="text" tone="muted" data-testid="reference-text">More tools</Button>
        <IconButton variant="ghost" tone="danger" aria-label="Remove item" data-testid="reference-danger"><Trash className="h-4 w-4" /></IconButton>
        <IconButton variant="ghost" aria-label="More actions" data-testid="reference-icon"><MoreHoriz className="h-4 w-4" /></IconButton>
        <Button isDisabled variant="primary">Unavailable</Button>
        <Button isPending variant="outline" data-testid="reference-pending">Saving</Button>
      </div>
      <Text variant="caption" tone="muted" role="status">Actions: {actions}</Text>
    </Section>
    <Section title="Form controls">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="reference-name"><Input id="reference-name" data-testid="reference-input" /></Field>
        <Field label="Access" htmlFor="reference-access"><Select id="reference-access" data-testid="reference-select"><option value="viewer">Viewer</option><option value="editor">Editor</option></Select></Field>
        <Field label="Native access" htmlFor="reference-native"><Select native id="reference-native" data-testid="reference-native"><option value="viewer">Viewer</option><option value="editor">Editor</option></Select></Field>
        <Field label="Model" htmlFor="reference-model" labelId="reference-model-label">
          <MenuTrigger><FormPickerTrigger id="reference-model" aria-labelledby="reference-model-label" data-testid="reference-picker">{model}</FormPickerTrigger>
            <FormPickerPopover><StudioMenu aria-label="Model choices" selectionMode="single" selectedKeys={new Set([model])} onAction={key => setModel(String(key))}>
              <StudioMenuItem id="Default">Default</StudioMenuItem><StudioMenuItem id="Custom">Custom</StudioMenuItem>
            </StudioMenu></FormPickerPopover>
          </MenuTrigger>
        </Field>
      </div>
      <Checkbox label="Include selected files" isSelected={checked} onChange={setChecked} data-testid="reference-checkbox" />
      <Toggle label="Notify me" isSelected={enabled} onChange={setEnabled} />
      <SegmentedControl aria-label="Changes view" value={selection} onChange={setSelection} width="fit"
        options={[{ value: "files", label: "Files" }, { value: "all", label: "All changes" }]} />
    </Section>
    <Section title="Status and recovery">
      <div className="flex flex-wrap gap-2">
        <Badge tone="info">Information</Badge><Badge tone="success">Connected</Badge><Badge tone="warning">Needs attention</Badge><Badge tone="danger">Failed</Badge>
      </div>
      <InlineNotice tone="success" role="status">Your changes were saved.</InlineNotice>
      <InlineNotice tone="danger" role="alert" actions={<Button variant="text" tone="danger">Try again</Button>}>The request could not be completed.</InlineNotice>
      <Surface tone="success" shadow="none" className="p-3"><Text tone="success" variant="body">Connected successfully.</Text></Surface>
    </Section>
    <Section title="Scrolling editor">
      <Button variant="outline" onPress={() => setEditorOpen(true)}>Open editor</Button>
    </Section>
    <StudioDialogModal isOpen={editorOpen} onOpenChange={setEditorOpen} layout="editor" dialogAriaLabel="Reference editor">
      <StudioDialogHeader title="Reference editor" onClose={() => setEditorOpen(false)} />
      <StudioDialogBody scrollable>
        <div className="space-y-4">
          <Field label="Draft" htmlFor="reference-draft"><Input id="reference-draft" value={draft} onChange={event => setDraft(event.target.value)} /></Field>
          {Array.from({ length: 16 }, (_, index) => <Text key={index} variant="body">Example content {index + 1}. The body scrolls while the title and actions stay reachable.</Text>)}
        </div>
      </StudioDialogBody>
      <StudioDialogFooter className="flex justify-end gap-2 px-5 py-4"><Button variant="outline" onPress={() => setEditorOpen(false)}>Cancel</Button><Button variant="primary" onPress={() => setEditorOpen(false)}>Done</Button></StudioDialogFooter>
    </StudioDialogModal>
  </main>;
}

createRoot(document.getElementById("root")!).render(<ComponentReference />);
