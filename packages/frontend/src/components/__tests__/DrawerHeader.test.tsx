import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrawerHeader } from "../DrawerHeader";
import { PageTitleInNavigationContext } from "../PageTitleContext";

describe("DrawerHeader page title ownership", () => {
  it("preserves actions and path context when navigation supplies the title", () => {
    const html = renderToStaticMarkup(<PageTitleInNavigationContext.Provider value="Files">
      <DrawerHeader title="Files" pageTitle subtitle="src · 3 items" actions={<button>New file</button>} />
    </PageTitleInNavigationContext.Provider>);
    expect(html).not.toContain(">Files<");
    expect(html).toContain("src · 3 items");
    expect(html).toContain("New file");
  });

  it("keeps embedded drawer titles and standalone page titles", () => {
    const embedded = renderToStaticMarkup(<PageTitleInNavigationContext.Provider value="Files">
      <DrawerHeader title="Participants" />
    </PageTitleInNavigationContext.Provider>);
    expect(embedded).toContain(">Participants<");
    const differentPage = renderToStaticMarkup(<PageTitleInNavigationContext.Provider value="index.ts">
      <DrawerHeader title="Files" pageTitle />
    </PageTitleInNavigationContext.Provider>);
    expect(differentPage).toContain(">Files<");
    expect(renderToStaticMarkup(<DrawerHeader title="Files" pageTitle />)).toContain(">Files<");
  });

  it("does not leave an empty title row when there is nothing else in it", () => {
    expect(renderToStaticMarkup(<PageTitleInNavigationContext.Provider value="Files">
      <DrawerHeader title="Files" pageTitle />
    </PageTitleInNavigationContext.Provider>)).toBe("");
  });
});
