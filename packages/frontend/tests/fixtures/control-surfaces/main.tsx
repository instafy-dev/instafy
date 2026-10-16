import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SettingsFormActions } from "../../../src/components/SettingsFormActions";
import { Surface } from "../../../src/components/Surface";
import { Text } from "../../../src/components/Text";
import { FilesExplorerToolbar } from "../../../src/screens/studio/components/FilesExplorerToolbar";
import { PersonalAppearanceSettings } from "../../../src/screens/studio/components/PersonalAppearanceSettings";
import { ThemeProvider } from "../../../src/theme/ThemeProvider";
import { RuntimeSurfaces } from "./RuntimeSurfaces";
import "../../../src/styles/tailwind.css";

// Local-only review entrypoint: actual product components with inert action handlers.
// Use localhost rather than the app's 127.0.0.1 origin to isolate theme preferences.
function ControlSurfaces() {
  const [search, setSearch] = useState("");
  const [saveCount, setSaveCount] = useState(0);
  return <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
    <header className="space-y-1">
      <Text as="h1" variant="title" tone="primary">Control surface review</Text>
      <Text variant="body" tone="muted">Actual Files, Appearance, settings actions and machine controls. Preview actions do not change your workspace.</Text>
    </header>
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Surface role="region" aria-label="Settings controls" shadow="none" className="space-y-5 p-4">
        <PersonalAppearanceSettings />
        <SettingsFormActions saveLabel="Save changes" onSave={() => setSaveCount(n => n + 1)}
          onCancel={() => setSaveCount(0)} hint="Example footer for settings that require saving."
          saveTestId="review-save" cancelTestId="review-cancel" />
        <Text variant="caption" tone="muted" role="status">Preview saves: {saveCount}</Text>
      </Surface>
      <Surface role="region" aria-label="Files controls" shadow="none" className="px-4 pb-4">
        <FilesExplorerToolbar rootPath="/" onFocusDirectory={() => undefined}
          searchTerm={search} onSearchTermChange={setSearch} />
        <Text variant="caption" tone="muted" className="mt-4">Use the filter, type a path, then press Escape to return to the search button.</Text>
      </Surface>
      <RuntimeSurfaces />
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter><ThemeProvider><ControlSurfaces /></ThemeProvider></MemoryRouter>,
);
