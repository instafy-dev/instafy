import type { AssistantProviderDefinition } from "@instafy/sdk/agents";

export const LOCAL_ROBOT_ASSISTANT_PROVIDER: AssistantProviderDefinition = {
  id: "local_robot_assistant",
  title: "Local robot assistant",
  description: "Registers the embodied Knosh assistant for the local robot capability surface.",
  assistants: [
    {
      handle: "knosh",
      mentionToken: "@knosh",
      displayName: "Knosh",
      aliases: [],
      capabilityBindings: [
        {
          capabilityId: "robot_embodiment",
          enabled: true,
          source: "system",
        },
        {
          // Product-true: the robot's brain is a phone, so its phone camera IS
          // the robot's camera. Without this binding, visual questions like
          // "hey knosh, what fruit is this?" never reach the
          // answer_visual_question route (canHandleCameraObservationPrompt
          // requires the assistant to hold camera_observation).
          capabilityId: "camera_observation",
          enabled: true,
          source: "system",
        },
      ],
      summary: "Embodied robot assistant with access to the Knosh control surface.",
      promptSummary:
        "Embodied assistant that can translate user requests into safe high-level robot behaviors.",
      promptInstructions: [
        "Interpret natural-language requests into high-level robot behaviors when they fit the available control surface.",
        "Prefer safe high-level actions over low-level device-specific control details.",
        "Use the camera observation capability when the user shows an object and asks a visual question such as 'what fruit is this' or 'what do you see'.",
        "If a request exceeds known robot capabilities, explain the limit instead of inventing unsupported behavior.",
      ],
    },
  ],
};
