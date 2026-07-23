import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExtensionDeveloperDetails } from "../ExtensionDeveloperDetails";

describe("ExtensionDeveloperDetails", () => {
  it("renders the shared developer detail fields for project integrations", () => {
    const html = renderToStaticMarkup(
      <ExtensionDeveloperDetails
        eligibleAssistantLabel="@camera"
        kindLabel="Sensor"
        discoveredCapabilityLabel="camera_observation"
        projectCapabilityLabel="camera_observation"
        integrationId="integration-123"
        source="project_integration"
      />,
    );

    expect(html).toContain("Eligible assistants: @camera");
    expect(html).toContain("Family: Sensor");
    expect(html).toContain("Extension capabilities: camera_observation");
    expect(html).toContain("Space scope: camera_observation");
    expect(html).toContain("Integration record: integration-123");
    expect(html).toContain("saved project policy rather than live extension discovery");
  });
});
