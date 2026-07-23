import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExtensionRowDetails } from "../extensionRowDetails";

describe("ExtensionRowDetails", () => {
  it("renders shared detail sections for a saved native setup row", () => {
    const html = renderToStaticMarkup(
      <ExtensionRowDetails
        familyDetails={null}
        savedNativeStateLabel="Rear lens selected."
        discoverable={false}
        discoveryError="Connection refused"
        customNativeSetupPanel={<div>Setup UI</div>}
        providerSurfaceDetails={<div>Provider surface</div>}
        developerDetails={<div>Developer details</div>}
        diagnosticsPanel={<div>Diagnostics</div>}
      />,
    );

    expect(html).toContain("Rear lens selected.");
    expect(html).toContain("Discovery error: Connection refused");
    expect(html).toContain("Setup UI");
    expect(html).toContain("Provider surface");
    expect(html).toContain("Developer details");
    expect(html).toContain("Diagnostics");
    expect(html.indexOf("Setup UI")).toBeLessThan(html.indexOf("Provider surface"));
  });

  it("renders the camera family device list with preferred-phone actions", () => {
    const html = renderToStaticMarkup(
      <ExtensionRowDetails
        familyDetails={<div>Attached phones <button>Use for new photos</button> Pixel 9</div>}
        savedNativeStateLabel={null}
        discoverable={true}
        discoveryError={null}
        customNativeSetupPanel={null}
        providerSurfaceDetails={null}
        developerDetails={null}
        diagnosticsPanel={null}
      />,
    );

    expect(html).toContain("Attached phones");
    expect(html).toContain("Use for new photos");
    expect(html).toContain("Pixel 9");
  });

  it("hides standalone saved-state and discovery captions when the provider surface covers them", () => {
    const html = renderToStaticMarkup(
      <ExtensionRowDetails
        familyDetails={null}
        savedNativeStateLabel="Rear lens selected."
        discoverable={false}
        discoveryError="Connection refused"
        hideSavedNativeStateLabel
        hideDiscoveryError
        customNativeSetupPanel={null}
        providerSurfaceDetails={<div>Provider surface</div>}
        developerDetails={null}
        diagnosticsPanel={null}
      />,
    );

    expect(html).not.toContain("Rear lens selected.");
    expect(html).not.toContain("Discovery error: Connection refused");
    expect(html).toContain("Provider surface");
  });
});
