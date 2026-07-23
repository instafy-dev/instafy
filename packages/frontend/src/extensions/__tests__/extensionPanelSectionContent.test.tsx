import { describe, expect, it } from "vitest";
import {
  buildExtensionPanelSectionViewModel,
  resolveExtensionPanelSectionNotice,
} from "../extensionPanelSectionContent";

describe("resolveExtensionPanelSectionNotice", () => {
  it("asks the user to select a space when there is no active project", () => {
    expect(
      resolveExtensionPanelSectionNotice({
        activeProjectId: null,
        localProvidersError: null,
        localProviderHostUnavailableOnThisClient: false,
        projectIntegrationsError: null,
        localProvidersLoading: false,
        projectIntegrationsLoading: false,
        projectExtensionsCount: 0,
      }),
    ).toEqual({
      tone: "info",
      message: "Select a space first.",
    });
  });

  it("surfaces project integration errors ahead of discovery status", () => {
    expect(
      resolveExtensionPanelSectionNotice({
        activeProjectId: "project-1",
        localProvidersError: "Provider host offline",
        localProviderHostUnavailableOnThisClient: false,
        projectIntegrationsError: "Controller unavailable",
        localProvidersLoading: false,
        projectIntegrationsLoading: false,
        projectExtensionsCount: 0,
      }),
    ).toEqual({
      tone: "warning",
      title: "Access unavailable",
      message: "Could not load extension access: Controller unavailable",
    });
  });

  it("surfaces local provider host errors when no extensions are resolved", () => {
    expect(
      resolveExtensionPanelSectionNotice({
        activeProjectId: "project-1",
        localProvidersError: "Provider host offline",
        localProviderHostUnavailableOnThisClient: false,
        projectIntegrationsError: null,
        localProvidersLoading: false,
        projectIntegrationsLoading: false,
        projectExtensionsCount: 0,
      }),
    ).toEqual({
      tone: "warning",
      title: "Local providers unavailable",
      message: "Provider host offline",
    });
  });

  it("does not show a local provider host warning when extensions are already resolved", () => {
    expect(
      resolveExtensionPanelSectionNotice({
        activeProjectId: "project-1",
        localProvidersError: "Provider host offline",
        localProviderHostUnavailableOnThisClient: false,
        projectIntegrationsError: null,
        localProvidersLoading: false,
        projectIntegrationsLoading: false,
        projectExtensionsCount: 1,
      }),
    ).toBeNull();
  });

  it("shows a loading message when discovery is in progress and no extensions are resolved yet", () => {
    expect(
      resolveExtensionPanelSectionNotice({
        activeProjectId: "project-1",
        localProvidersError: null,
        localProviderHostUnavailableOnThisClient: false,
        projectIntegrationsError: null,
        localProvidersLoading: true,
        projectIntegrationsLoading: false,
        projectExtensionsCount: 0,
      }),
    ).toEqual({
      tone: "info",
      title: "Checking extensions",
      message: "Looking for devices and saved access.",
    });
  });

  it("shows an empty-state message when discovery completes with no extensions", () => {
    expect(
      resolveExtensionPanelSectionNotice({
        activeProjectId: "project-1",
        localProvidersError: null,
        localProviderHostUnavailableOnThisClient: false,
        projectIntegrationsError: null,
        localProvidersLoading: false,
        projectIntegrationsLoading: false,
        projectExtensionsCount: 0,
      }),
    ).toEqual({
      tone: "info",
      title: "No extensions yet",
      message: "Open Instafy on a phone or desktop to add a camera or board.",
    });
  });

  it("builds a reduced section view model with derived notice state", () => {
    const viewModel = buildExtensionPanelSectionViewModel({
      activeProjectId: "project-1",
      activeProjectName: "Kitchen",
      pendingProviderId: null,
      showDeveloperDetails: true,
      expandedProviderDetails: { "provider-1": true },
      localProviderHostUnavailableOnThisClient: false,
      localProvidersLoading: false,
      localProvidersError: null,
      projectIntegrationsLoading: false,
      projectIntegrationsError: null,
      currentNativeCameraStatus: null,
      nativeRuntimeStatusByProvider: {},
      nativeAuxiliaryStatusByProvider: {},
      nativeCameraHealthStateByProvider: {},
      remoteCameraRequestsByProvider: {},
      remoteCameraDevicesByProvider: {},
      projectExtensions: [],
      attachedExtensionFamilyCounts: new Map(),
      cameraAttachedDeviceItems: [],
      providerEventLogEntries: [],
      providerTriggerCandidates: [],
    });

    expect(viewModel.activeProjectName).toBe("Kitchen");
    expect(viewModel.showDeveloperDetails).toBe(true);
    expect(viewModel.expandedProviderDetails).toEqual({ "provider-1": true });
    expect(viewModel.sectionNotice).toEqual({
      tone: "info",
      title: "No extensions yet",
      message: "Open Instafy on a phone or desktop to add a camera or board.",
    });
  });
});
