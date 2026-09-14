// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppReleaseMetadata } from "../../../../updates/releaseMetadata";
import type { DevDiagnosticsMenu } from "../DevDiagnosticsMenu";
import { StudioAccountMenu } from "../StudioAccountMenu";
import { resolveHumanAvatarColors } from "../../../../utils/humanAvatar";

const mocks = vi.hoisted(() => ({
  metadata: null as AppReleaseMetadata | null,
  desktop: true, native: false, large: false,
  refresh: vi.fn(), download: vi.fn(), install: vi.fn(), check: vi.fn(),
  otaInstall: vi.fn(), otaCheck: vi.fn(), showStatus: vi.fn(), nativeBack: vi.fn(),
  copyTunnel: vi.fn(), clearLogs: vi.fn(), onShowLogs: vi.fn(), onSupport: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => mocks.native ? "android" : "web" } }));
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({
  userEmail: "reader@example.test", hasLogs: true, onShowLogs: mocks.onShowLogs,
  onOpenBugReportInbox: mocks.onSupport,
}) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => mocks.large }));
vi.mock("../../../../profile/ProfileProvider", () => ({ useProfile: () => ({ profile: { fullName: "Alex Reader" } }) }));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "reader-user-id" } }) }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: "active-space" }) }));
vi.mock("../../../../runtime/useRuntimeMenu", () => ({ useRuntimeMenuOptions: () => ({ runtime: { copyTunnelDetails: mocks.copyTunnel }, runtimeOptions: [] }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.showStatus }) }));
vi.mock("../../../../debug/useAppLogs", () => ({ useAppLogs: () => ({ logs: [], hasLogs: true, hasErrors: true, clearLogs: mocks.clearLogs }) }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));
vi.mock("../../../../updates/useAppUpdateMetadata", () => ({ useAppUpdateMetadata: () => ({ metadata: mocks.metadata, refresh: mocks.refresh }) }));
vi.mock("../../../../updates/useDesktopReleaseLookup", () => ({ useDesktopReleaseLookup: () => ({ lookup: { status: "idle" } }) }));
vi.mock("../../../../updates/desktopAcquisition", () => ({ getAppAcquisitionTarget: () => null }));
vi.mock("../../../../desktop/updates/client", () => ({
  desktopUpdaterBridgeAvailable: () => mocks.desktop,
  downloadDesktopUpdaterNow: mocks.download, installDesktopUpdaterNow: mocks.install,
  checkDesktopUpdaterNow: mocks.check,
}));
vi.mock("../../../../mobile/ota/shared", () => ({ otaIsSupportedOnThisClient: () => mocks.native }));
vi.mock("../../../../mobile/ota/bootstrap", () => ({ applyStagedNativeOtaUpdate: mocks.otaInstall, triggerNativeOtaCheck: mocks.otaCheck }));
vi.mock("../DevDiagnosticsMenu", () => ({ DevDiagnosticsMenu: (props: ComponentProps<typeof DevDiagnosticsMenu>) => <div>
  <button data-testid="test-runtime-logs" onClick={props.onShowLogs}>Logs</button>
  <button data-testid="test-app-logs" onClick={props.onShowAppLogs}>App logs</button>
  <button data-testid="test-copy-tunnel" onClick={() => props.onCopyTunnel("url", "runtime-a")}>Copy</button>
</div> }));
vi.mock("../BuildLogOverlay", () => ({ BuildLogOverlay: ({ onClose, onClear }: { onClose: () => void; onClear: () => void }) => <div data-testid="test-app-log-overlay">
  <button data-testid="test-clear-app-logs" onClick={onClear}>Clear</button><button onClick={onClose}>Close</button>
</div> }));

function metadata(surface: AppReleaseMetadata["runtime_surface"], action: AppReleaseMetadata["updates"]["primary_action"]): AppReleaseMetadata {
  return {
    build: { app: "instafy-frontend", packageVersion: "1.0.0", gitCommit: "12345678", gitCommitShort: "12345678", gitBranch: "main", builtAt: "2026-09-14T00:00:00Z", releaseId: "test" },
    runtime_surface: surface, binary: { version: "1.0.0", label: "Test build", platform: surface },
    updates: { supported: true, is_enabled: true, primary_action: action, channel: "stable", phase: action === "install" ? "downloaded" : "update_available", current_bundle_version: null, current_git_sha: null, available_version: "1.0.1", native_version: "1.0.0", feed_url: null, last_checked_at: null, last_downloaded_at: null, last_error: null, last_check_reason: null },
  };
}

describe("shared Studio account controller", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    mocks.desktop = true; mocks.native = false; mocks.large = false;
    mocks.metadata = metadata("desktop", "download");
    mocks.refresh.mockImplementation(async () => mocks.metadata);
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(props: ComponentProps<typeof StudioAccountMenu> = { presentation: "header" }) {
    await act(async () => root.render(<StudioAccountMenu {...props} />));
  }
  async function click(testId: string) {
    const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    expect(target).not.toBeNull();
    await act(async () => target!.click());
  }
  async function clickText(label: string) {
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === label);
    expect(target).toBeDefined();
    await act(async () => target!.click());
  }
  async function openUpdates() {
    await click("topbar-profile-button");
    await click("profile-updates-button");
    expect(document.querySelector('[data-testid="profile-account-sheet"]')).toBeNull();
    expect(document.querySelector('[aria-label="App updates"]')).not.toBeNull();
  }

  it("moves compact account updates into the same updater and reports failed downloads", async () => {
    mocks.download.mockResolvedValue({ phase: "error", lastError: "Network unavailable" });
    await render();
    await openUpdates();
    expect(mocks.refresh).toHaveBeenCalled();
    await clickText("Download update");
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.showStatus).toHaveBeenCalledWith("Network unavailable", "error", 3500);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.nativeBack).toHaveBeenCalledWith(true, expect.any(Function), 260);
  });

  it("uses the authenticated user ID for the same header and account-menu avatar", async () => {
    await render();
    const headerAvatar = container.querySelector<HTMLElement>("[data-human-avatar]")!;
    expect(headerAvatar.textContent).toBe("AR");
    expect(headerAvatar.style.getPropertyValue("--human-avatar-background")).toBe(resolveHumanAvatarColors("reader-user-id").background);
    await click("topbar-profile-button");
    const menuAvatar = document.querySelector<HTMLElement>('[data-testid="profile-account-sheet"] [data-human-avatar]')!;
    expect(menuAvatar.getAttribute("style")).toBe(headerAvatar.getAttribute("style"));
  });

  it("consumes native Back while an update is pending and dismisses only after it finishes", async () => {
    let finish!: (value: { phase: string }) => void;
    mocks.download.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render(); await openUpdates(); await clickText("Download update");
    const updateBack = () => {
      const registration = [...mocks.nativeBack.mock.calls].reverse().find(([enabled, , priority]) => enabled && priority === 260);
      expect(registration).toBeDefined();
      registration![1]();
    };
    await act(async () => updateBack());
    expect(document.querySelector('[aria-label="App updates"]')).not.toBeNull();
    await act(async () => finish({ phase: "downloaded" }));
    await act(async () => updateBack());
    expect(document.querySelector('[aria-label="App updates"]')).toBeNull();
  });

  it("keeps a declined desktop restart pending for later without a success claim", async () => {
    mocks.metadata = metadata("desktop", "install");
    mocks.install.mockResolvedValue({ lastInstallRequestAccepted: false });
    await render(); await openUpdates(); await clickText("Restart to update");
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.showStatus).toHaveBeenCalledExactlyOnceWith("Update kept for later.", "info", 2500);
  });

  it.each(["check", "install"] as const)("keeps native OTA %s available through the compact account menu", async action => {
    mocks.desktop = false; mocks.native = true;
    mocks.metadata = metadata("native-ota", action);
    mocks.otaCheck.mockResolvedValue({ update_available: true });
    mocks.otaInstall.mockResolvedValue(true);
    await render(); await openUpdates();
    await clickText(action === "check" ? "Check now" : "Restart to update");
    expect(action === "check" ? mocks.otaCheck : mocks.otaInstall).toHaveBeenCalledOnce();
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalledWith(action === "check" ? "Update detected. Instafy is staging it now." : "Restarting to apply the staged update.", "success", 3000);
  });

  it("retains diagnostics, runtime logs, tunnel copying and app log controls", async () => {
    await render(); await click("topbar-profile-button");
    await act(async () => document.querySelector<HTMLDetailsElement>("details")!.setAttribute("open", ""));
    await click("profile-diagnostics-button");
    await click("test-runtime-logs"); await click("test-copy-tunnel");
    expect(mocks.onShowLogs).toHaveBeenCalledOnce();
    expect(mocks.copyTunnel).toHaveBeenCalledExactlyOnceWith("url", "runtime-a");
    await click("test-app-logs"); await click("test-clear-app-logs");
    expect(mocks.clearLogs).toHaveBeenCalledOnce();
    expect(mocks.nativeBack).toHaveBeenCalledWith(true, expect.any(Function), 270);
  });

  it("retains sidebar footer measurement without mounting navigation in the account controller", async () => {
    const footerRef = createRef<HTMLDivElement>();
    mocks.large = true;
    await render({ presentation: "sidebar", footerRef, showLabels: true });
    expect(footerRef.current?.querySelector('[data-testid="sidebar-profile-menu"]')).not.toBeNull();
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector('[data-testid="topbar-profile-button"]')).toBeNull();
  });
});
