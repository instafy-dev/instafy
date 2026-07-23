import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSection } from "../SettingsSection";

describe("SettingsSection", () => {
  it("can hide description on mobile when a screen opts into desktop-only helper copy", () => {
    const html = renderToStaticMarkup(
      <SettingsSection title="Devices and tools" description="Add or manage connected devices." descriptionVisibility="desktop">
        <div>Body</div>
      </SettingsSection>,
    );

    expect(html).not.toContain("Attach the tools and devices this space can use.");
    expect(html).toContain("Devices and tools");
  });
});
