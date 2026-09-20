export const KNOSH_PROVIDER_ID = "knosh";
export const KNOSH_PROVIDER_TITLE = "Knosh";
export const KNOSH_PROVIDER_DESCRIPTION =
  "Embodied robot provider backed by the local Knosh transport and workflow tools.";
export const KNOSH_PROVIDER_KIND = "embodied_robot";
export const KNOSH_PROVIDER_TYPE = "knosh";
export const ROBOT_EMBODIMENT_CAPABILITY_ID = "robot_embodiment";
export const KNOSH_APPEND_SESSION_EVENTS_TOOL_ID =
  "knosh.robot.session.events.append";
export const KNOSH_BUILD_LEARN_DRAFT_TOOL_ID =
  "knosh.robot.learning.draft.build";
export const KNOSH_RUN_REPLAY_HARNESS_TOOL_ID =
  "knosh.robot.replay.run_harness";
export const KNOSH_IMPORT_REPLAY_REPORT_TOOL_ID =
  "knosh.robot.replay.import_report";
export const KNOSH_DEFAULT_ROBOT_PROFILE_RESOURCE_URI =
  "knosh://robot/profile/default";
export const KNOSH_LATEST_REPLAY_REPORT_RESOURCE_URI =
  "knosh://robot/replay/latest-report";

const KNOSH_PROVIDER_MANIFEST = Object.freeze({
  familyId: KNOSH_PROVIDER_ID,
  hostSurfaces: Object.freeze([
    {
      surface: "extension_tile",
      title: KNOSH_PROVIDER_TITLE,
      description: "Robot control for this space.",
      capabilityIds: [ROBOT_EMBODIMENT_CAPABILITY_ID],
      metadata: {
        kind: "robot",
        policy: {
          trustLevel: "first_party",
          renderMode: "host_declarative",
        },
        elements: [
          {
            element: "highlights",
            items: ["Robot control", "Native device setup"],
          },
          {
            element: "facts",
            facts: [
              {
                label: "Transport",
                value:
                  "Native board connection with project-scoped attachment",
              },
              {
                label: "Focus",
                value: "Control a nearby Knosh board from this space",
              },
            ],
          },
          {
            element: "actions",
            actions: [
              {
                label: "Attachment",
                description: "Attach or detach this provider.",
                variant: "outline",
                binding: {
                  hostBindingId: "extension_attachment_action",
                },
              },
            ],
          },
          {
            element: "section",
            title: "Setup",
            items: [
              "Connect a compatible board.",
              "Attach it before issuing control actions.",
            ],
            binding: {
              hostBindingId: "extension_setup_guidance",
            },
          },
          {
            element: "section",
            title: "Current attachment",
            binding: {
              hostBindingId: "extension_attachment_status",
            },
          },
          {
            element: "section",
            title: "Current runtime",
            binding: {
              hostBindingId: "extension_runtime_status",
            },
          },
          {
            element: "section",
            title: "Saved setup",
            binding: {
              hostBindingId: "extension_saved_state",
            },
          },
          {
            element: "section",
            title: "Availability issue",
            binding: {
              hostBindingId: "extension_issue_status",
            },
          },
        ],
      },
    },
    {
      surface: "detail_view",
      title: "Knosh diagnostics",
      description: "Inspect Knosh connection and saved setup.",
      capabilityIds: [ROBOT_EMBODIMENT_CAPABILITY_ID],
      metadata: {
        kind: "robot",
        policy: {
          trustLevel: "first_party",
          renderMode: "host_declarative",
        },
        elements: [
          {
            element: "highlights",
            items: ["Diagnostics", "Replay visibility"],
          },
          {
            element: "facts",
            facts: [
              {
                label: "Inspection",
                value:
                  "Transport reachability, runtime state, and replay diagnostics",
              },
              {
                label: "Use case",
                value:
                  "Debug robot connectivity without leaving the Instafy shell",
              },
            ],
          },
          {
            element: "actions",
            actions: [
              {
                label: "Attachment",
                description: "Attach or detach this provider.",
                variant: "outline",
                binding: {
                  hostBindingId: "extension_attachment_action",
                },
              },
            ],
          },
          {
            element: "section",
            title: "Setup",
            items: [
              "Connect a compatible board.",
              "Attach it before issuing control actions.",
              "Use setup below to scan, connect, and save a board.",
            ],
            binding: {
              hostBindingId: "extension_setup_guidance",
            },
          },
          {
            element: "section",
            title: "Current attachment",
            binding: {
              hostBindingId: "extension_attachment_status",
            },
          },
          {
            element: "section",
            title: "Current runtime",
            binding: {
              hostBindingId: "extension_runtime_status",
            },
          },
          {
            element: "section",
            title: "Saved setup",
            binding: {
              hostBindingId: "extension_saved_state",
            },
          },
          {
            element: "section",
            title: "Availability issue",
            binding: {
              hostBindingId: "extension_issue_status",
            },
          },
        ],
      },
    },
  ]),
});

export const KNOSH_PROVIDER_FAMILY = Object.freeze({
  id: KNOSH_PROVIDER_ID,
  title: KNOSH_PROVIDER_TITLE,
  description: KNOSH_PROVIDER_DESCRIPTION,
  kind: KNOSH_PROVIDER_KIND,
  providerType: KNOSH_PROVIDER_TYPE,
  rootUri: "knosh://",
  transportProbeSupported: true,
  capabilityIds: Object.freeze([ROBOT_EMBODIMENT_CAPABILITY_ID]),
  toolAliases: Object.freeze({
    appendSessionEvents: KNOSH_APPEND_SESSION_EVENTS_TOOL_ID,
    buildLearnDraft: KNOSH_BUILD_LEARN_DRAFT_TOOL_ID,
    runReplayHarness: KNOSH_RUN_REPLAY_HARNESS_TOOL_ID,
    importReplayReport: KNOSH_IMPORT_REPLAY_REPORT_TOOL_ID,
  }),
  resourceAliases: Object.freeze({
    defaultRobotProfile: KNOSH_DEFAULT_ROBOT_PROFILE_RESOURCE_URI,
    latestReplayReport: KNOSH_LATEST_REPLAY_REPORT_RESOURCE_URI,
  }),
  manifest: KNOSH_PROVIDER_MANIFEST,
  extension: Object.freeze({
    listDescription: "Robot control for this space.",
    kind: "robot",
    nativeRuntimeUi: Object.freeze({
      stateLabels: Object.freeze({
        attached: "Attached for {scopeLabel}.",
        detached: "Saved.",
        nativeAttached: "This device controls Knosh in {scopeLabel}.",
        nativeDetached: "Open setup to connect to Knosh.",
      }),
      attachAction: Object.freeze({
        label: "Attach",
        pendingLabel: "Attaching…",
        nativeRuntimeVariant: "outline",
      }),
      detachAction: Object.freeze({
        label: "Detach",
        pendingLabel: "Detaching…",
      }),
      detailsAction: Object.freeze({
        setupLabel: "Setup",
        manageLabel: "Manage",
        hideLabel: "Close",
      }),
      savedDeviceLabel: "Saved board",
    }),
    nativeRuntimeProvider: Object.freeze({
      id: KNOSH_PROVIDER_ID,
      title: KNOSH_PROVIDER_TITLE,
      description: "Connect a Knosh board over Bluetooth.",
      providerType: KNOSH_PROVIDER_TYPE,
      kind: "robot",
      configured: true,
      discoverable: true,
      capabilityIds: Object.freeze([ROBOT_EMBODIMENT_CAPABILITY_ID]),
      manifest: Object.freeze({
        familyId: KNOSH_PROVIDER_ID,
      }),
    }),
  }),
});
