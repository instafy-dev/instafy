import type { BuiltInProviderFamilyDefinition } from "@instafy/provider-contract/builtins";

export const KNOSH_PROVIDER_ID: "knosh";
export const KNOSH_PROVIDER_TITLE: "Knosh";
export const KNOSH_PROVIDER_DESCRIPTION: string;
export const KNOSH_PROVIDER_KIND: "embodied_robot";
export const KNOSH_PROVIDER_TYPE: "knosh";
export const ROBOT_EMBODIMENT_CAPABILITY_ID: "robot_embodiment";
export const KNOSH_APPEND_SESSION_EVENTS_TOOL_ID: "knosh.robot.session.events.append";
export const KNOSH_BUILD_LEARN_DRAFT_TOOL_ID: "knosh.robot.learning.draft.build";
export const KNOSH_RUN_REPLAY_HARNESS_TOOL_ID: "knosh.robot.replay.run_harness";
export const KNOSH_IMPORT_REPLAY_REPORT_TOOL_ID: "knosh.robot.replay.import_report";
export const KNOSH_DEFAULT_ROBOT_PROFILE_RESOURCE_URI: "knosh://robot/profile/default";
export const KNOSH_LATEST_REPLAY_REPORT_RESOURCE_URI: "knosh://robot/replay/latest-report";

export const KNOSH_PROVIDER_FAMILY: BuiltInProviderFamilyDefinition;
