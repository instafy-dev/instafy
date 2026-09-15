import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsShell } from "../SettingsShell";

describe("SettingsShell", () => {
  it("renders one compact category path for nested settings", () => {
    const html = renderToStaticMarkup(
      <SettingsShell
        title="Space settings"
        categories={[
          { id: "overview", label: "Overview" },
          {
            id: "voice",
            label: "Voice & audio",
            children: [
              { id: "speech", label: "Speech provider" },
              { id: "audio", label: "Host audio" },
            ],
          },
        ]}
        activeCategoryId="voice"
        onCategoryChange={() => undefined}
        activeChildCategoryId="speech"
        onChildCategoryChange={() => undefined}
      >
        <div>Body</div>
      </SettingsShell>,
    );

    expect(html).toContain("data-testid=\"settings-category-nav-picker\"");
    expect(html).not.toContain("data-testid=\"settings-category-nav-child-picker\"");
    expect(html).toContain("Speech provider");
    expect(html).not.toContain("data-testid=\"settings-shell-subtitle\"");
    expect(html).not.toContain("data-testid=\"settings-category-nav-scroll-left\"");
  });

  it("can hide subtitle and scope on mobile when a screen opts into desktop-only chrome", () => {
    const html = renderToStaticMarkup(
      <SettingsShell
        title="Extensions"
        subtitle="Choose which tools and devices this space can use."
        subtitleVisibility="desktop"
        scope={<span>Space · Demo</span>}
        scopeVisibility="desktop"
      >
        <div>Body</div>
      </SettingsShell>,
    );

    expect(html).not.toContain("Choose which tools and devices this space can use.");
    expect(html).not.toContain("Space · Demo");
    expect(html).toContain("Extensions");
  });

  it("can hide the title on mobile when the shell is already labeled elsewhere", () => {
    const html = renderToStaticMarkup(
      <SettingsShell title="Extensions" titleVisibility="desktop">
        <div>Body</div>
      </SettingsShell>,
    );

    expect(html).not.toContain("Extensions");
    expect(html).toContain("Body");
  });

  it("keeps a picker for larger or nested category sets even if compact tabs are requested", () => {
    for (const categories of [
      ["one", "two", "three", "four"].map(id => ({ id, label: id })),
      [{ id: "one", label: "One", children: [{ id: "child", label: "Child" }] }],
    ]) {
      const html = renderToStaticMarkup(
        <SettingsShell title="Settings" compactCategoryNavigation="tabs" categories={categories} activeCategoryId="one" onCategoryChange={() => undefined}>
          <p>Body</p>
        </SettingsShell>,
      );
      expect(html).toContain('data-testid="settings-category-nav-picker"');
      expect(html).not.toContain('data-testid="settings-category-nav-tabs"');
    }
  });
});
