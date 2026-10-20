import { LegacyChangesDrawer } from "../../../src/screens/studio/components/LegacyChangesDrawer";

/** Production Changes controls with the fixture's inert Git data. */
export function ChangesPreview() {
  return <section className="h-full min-h-0" aria-label="Changes workspace">
    <LegacyChangesDrawer openRequest={{ key: 1, previewPath: "src/welcome.ts", reviewMode: "all" }} />
  </section>;
}
