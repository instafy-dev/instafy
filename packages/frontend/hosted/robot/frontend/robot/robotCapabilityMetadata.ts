import type { CapabilityActionDefinition } from "@instafy/sdk/capabilities";
import {
  KNOSH_PROVIDER_ID,
  KNOSH_PROVIDER_TITLE,
  KNOSH_PROVIDER_TYPE,
  ROBOT_EMBODIMENT_CAPABILITY_ID,
} from "../../provider/family.mjs";

export {
  KNOSH_PROVIDER_ID,
  KNOSH_PROVIDER_TITLE,
  KNOSH_PROVIDER_TYPE,
  ROBOT_EMBODIMENT_CAPABILITY_ID,
};

export const ROBOT_EMBODIMENT_ACTIONS: CapabilityActionDefinition[] = [
  {
    id: "perform_behavior",
    title: "Perform behavior",
    description: "Resolve a high-level embodied prompt into transport steps.",
  },
  {
    id: "set_attention_target",
    title: "Set attention target",
    description: "Orient the robot head toward a user or target cue.",
  },
  {
    id: "move_base",
    title: "Move base",
    description: "Move the base through normalized linear and angular intent.",
  },
  {
    id: "stop",
    title: "Stop",
    description: "Stop ongoing robot motion immediately.",
  },
  {
    id: "get_state",
    title: "Get state",
    description: "Read typed robot state from the transport surface.",
  },
];

export const ROBOT_EMBODIMENT_ACTION_IDS = ROBOT_EMBODIMENT_ACTIONS.map((action) => action.id);
