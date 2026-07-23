import type { CapabilityActionDefinition } from "@instafy/sdk/capabilities";
export {
  CAMERA_CAPTURE_PHOTO_SERIES_TOOL_ID,
  CAMERA_CAPTURE_PHOTO_TOOL_ID,
  CAMERA_LATEST_CAPTURE_RESOURCE_URI,
  CAMERA_LENSES_RESOURCE_URI,
  CAMERA_OBSERVATION_CAPABILITY_ID,
  CAMERA_PROVIDER_ID,
  CAMERA_PROVIDER_TITLE,
  CAMERA_PROVIDER_TYPE,
  CAMERA_STATUS_RESOURCE_URI,
} from "@instafy/provider-contract/builtins";

export const CAMERA_OBSERVATION_ACTIONS: CapabilityActionDefinition[] = [
  {
    id: "capture_photo",
    title: "Capture photo",
    description: "Capture one fresh camera photo from the selected lens.",
  },
  {
    id: "capture_photo_series",
    title: "Capture photo series",
    description: "Capture a short burst or step-by-step photo series from the selected lens.",
  },
  {
    id: "get_camera_status",
    title: "Get camera status",
    description: "Read current camera permission, lenses, and latest-capture metadata.",
  },
  {
    id: "answer_visual_question",
    title: "Answer visual question",
    description:
      "Capture a fresh front-camera photo of what the user is showing and answer what it looks like.",
  },
];

export const CAMERA_OBSERVATION_ACTION_IDS = CAMERA_OBSERVATION_ACTIONS.map((action) => action.id);
