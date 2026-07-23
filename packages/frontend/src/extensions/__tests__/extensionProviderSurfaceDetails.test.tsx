import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExtensionProviderSurfaceDetails } from "../extensionProviderSurfaceDetails";

describe("ExtensionProviderSurfaceDetails", () => {
  it("renders saved native state, discovery issues, and provider surface details", () => {
    const html = renderToStaticMarkup(
      <ExtensionProviderSurfaceDetails
        savedNativeStateLabel="Rear lens selected."
        discoverable={false}
        discoveryError="Connection refused"
        providerSurfaceDetails={<div>Provider surface</div>}
      />,
    );

    expect(html).toContain("Rear lens selected.");
    expect(html).toContain("Discovery error: Connection refused");
    expect(html).toContain("Provider surface");
  });

  it("hides standalone saved-state and discovery captions when the provider surface covers them", () => {
    const html = renderToStaticMarkup(
      <ExtensionProviderSurfaceDetails
        savedNativeStateLabel="Rear lens selected."
        discoverable={false}
        discoveryError="Connection refused"
        hideSavedNativeStateLabel
        hideDiscoveryError
        providerSurfaceDetails={<div>Provider surface</div>}
      />,
    );

    expect(html).not.toContain("Rear lens selected.");
    expect(html).not.toContain("Discovery error: Connection refused");
    expect(html).toContain("Provider surface");
  });
});
