import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CameraNativeDiagnosticsPanel } from "../CameraNativeDiagnosticsPanel";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
  },
}));

describe("CameraNativeDiagnosticsPanel", () => {
  it("hides shell intro copy and uses a shorter embedded summary in compact embedded mode", () => {
    const html = renderToStaticMarkup(
      <CameraNativeDiagnosticsPanel compact embedded attached />,
    );

    expect(html).not.toContain("Use this device as Camera");
    expect(html).not.toContain("Keep this space open here");
    expect(html).toContain("Checking camera access.");
    expect(html.match(/Checking camera access\./g)?.length ?? 0).toBe(1);
    expect(html).toContain("Checking camera");
    expect(html).toContain("Check camera");
    expect(html).not.toContain("Access blocked");
    expect(html).not.toContain("Rear lens");
    expect(html).not.toContain("Front lens");
    expect(html).toContain("Check again");
  });

  it("can suppress the embedded runtime summary when the provider surface already renders it", () => {
    const html = renderToStaticMarkup(
      <CameraNativeDiagnosticsPanel
        compact
        embedded
        attached
        surfaceCoverage={{
          setupGuidance: true,
          attachmentStatus: true,
          runtimeStatus: true,
          savedState: true,
          availabilityIssue: false,
        }}
      />,
    );

    expect(html.match(/Checking camera access\./g)?.length ?? 0).toBe(1);
    expect(html).toContain("Checking camera");
    expect(html).toContain("Check camera");
    expect(html).not.toContain("Access blocked");
  });

  it("keeps the standalone panel focused on controls and diagnostics", () => {
    const html = renderToStaticMarkup(<CameraNativeDiagnosticsPanel attached />);

    expect(html).not.toContain("Use this device as Camera");
    expect(html).not.toContain("Keep this space open here");
    expect(html).toContain("Checking camera access.");
    expect(html.match(/Checking camera access\./g)?.length ?? 0).toBe(1);
    expect(html).toContain("Checking camera");
    expect(html).toContain("Check camera");
    expect(html).not.toContain("Access blocked");
    expect(html).toContain("Rear lens");
    expect(html).toContain("Front lens");
    expect(html).toContain("Check again");
  });
});
