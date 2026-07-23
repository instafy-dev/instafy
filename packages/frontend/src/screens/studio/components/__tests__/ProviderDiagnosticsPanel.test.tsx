import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderDiagnosticsPanel } from "../ProviderDiagnosticsPanel";

describe("ProviderDiagnosticsPanel", () => {
  const provider = {
    id: "camera:pixel-test",
    title: "Kitchen camera",
    capabilityIds: ["camera_observation"],
    discoverable: true,
    toolIds: ["capturePhoto"],
    resourceUris: ["camera://status"],
  } as never;

  it("renders as a collapsed toggle by default", () => {
    const html = renderToStaticMarkup(<ProviderDiagnosticsPanel provider={provider} />);

    expect(html).toContain("project-provider-diagnostics-toggle-camera:pixel-test");
    expect(html).toContain("Diagnostics");
    expect(html).not.toContain("project-provider-diagnostics-panel-camera:pixel-test");
    expect(html).not.toContain("Refresh discovery");
  });

  it("renders inline without a nested toggle when collapse is disabled", () => {
    const html = renderToStaticMarkup(
      <ProviderDiagnosticsPanel
        provider={provider}
        allowCollapse={false}
        autoDiscoverOnExpand={false}
      />,
    );

    expect(html).not.toContain("project-provider-diagnostics-toggle-camera:pixel-test");
    expect(html).toContain("project-provider-diagnostics-panel-camera:pixel-test");
    expect(html).toContain("Refresh discovery");
    expect(html).toContain("Read status resource");
  });
});
