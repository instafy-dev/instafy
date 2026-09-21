// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceControlsProvider } from "../../workspaceControls";
import { PersonalAdvancedSettings } from "../PersonalAdvancedSettings";
import { StudioDiagnostics } from "../StudioDiagnostics";

const mocks = vi.hoisted(() => ({ copyTunnel: vi.fn(), clearLogs: vi.fn(), onShowLogs: vi.fn(), nativeBack: vi.fn() }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: "space" }) }));
vi.mock("../../../../runtime/useRuntimeMenu", () => ({ useRuntimeMenuOptions: () => ({ runtime: { copyTunnelDetails: mocks.copyTunnel }, runtimeOptions: [] }) }));
vi.mock("../../../../debug/useAppLogs", () => ({ useAppLogs: () => ({ logs: [], hasLogs: true, clearLogs: mocks.clearLogs }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));
vi.mock("../BuildLogOverlay", () => ({ BuildLogOverlay: ({ onClose, onClear }: { onClose: () => void; onClear: () => void }) => <div data-testid="test-app-logs"><button onClick={onClear}>Clear app logs</button><button onClick={onClose}>Close app logs</button></div> }));

function Harness() {
  const [open, setOpen] = useState(false);
  return <WorkspaceControlsProvider value={{ userEmail: "reader@example.test", activeProjectName: "Space", hasLogs: true, onShowLogs: mocks.onShowLogs, onOpenDiagnostics: () => setOpen(true) }}>
    <PersonalAdvancedSettings />
    <StudioDiagnostics isOpen={open} onOpenChange={setOpen} />
  </WorkspaceControlsProvider>;
}

describe("Settings diagnostics", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn((media: string) => ({ matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const click = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === text);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  async function openTools() {
    await act(async () => document.querySelector("summary")!.click());
    await click("Open diagnostics");
  }

  it("starts collapsed and opens existing diagnostics only through the explicit action", async () => {
    expect(document.querySelector("details")?.open).toBe(false);
    expect(document.querySelector('[aria-label="Diagnostics"]')).toBeNull();
    await openTools();
    expect(document.querySelector("details")?.open).toBe(true);
    expect(document.querySelector('[aria-label="Diagnostics"]')).not.toBeNull();
    await click("View runtime logs");
    expect(mocks.onShowLogs).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="Diagnostics"]')).toBeNull();
  });

  it("keeps app logs mounted when leaving diagnostics and preserves log controls", async () => {
    await openTools();
    await click("View app logs");
    expect(document.querySelector('[aria-label="Diagnostics"]')).toBeNull();
    expect(document.querySelector('[data-testid="test-app-logs"]')).not.toBeNull();
    await click("Clear app logs");
    expect(mocks.clearLogs).toHaveBeenCalledOnce();
    expect(mocks.nativeBack).toHaveBeenCalledWith(true, expect.any(Function), 270);
    await click("Close app logs");
    expect(document.querySelector('[data-testid="test-app-logs"]')).toBeNull();
  });
});
