import type { AssistantProviderDefinition } from "@instafy/sdk/agents";

export const LOCAL_CORE_ASSISTANT_PROVIDER: AssistantProviderDefinition = {
  id: "local_core_assistants",
  title: "Local core assistants",
  description: "Registers the default conversational assistants for the Instafy frontend.",
  assistants: [
    {
      handle: "octo",
      mentionToken: "@octo",
      displayName: "Octo",
      aliases: ["ai"],
      capabilityBindings: [
        {
          capabilityId: "camera_observation",
          enabled: true,
          source: "system",
        },
        {
          capabilityId: "device_toggle",
          enabled: true,
          source: "system",
        },
      ],
      summary: "General Instafy assistant.",
      promptSummary:
        "General-purpose Instafy assistant for conversation, planning, and non-robotic tasks.",
      promptInstructions: [
        "Answer directly when the request is purely conversational or project-oriented.",
        "Use explicitly granted capabilities when the user asks for a supported local device or hardware action.",
        "Use the camera observation capability only when the user explicitly asks for a fresh photo or selfie.",
        "Do not claim to control hardware or perform embodied actions unless a capability is explicitly granted.",
      ],
    },
  ],
};
