import { fetchConversationMessagesFromController } from "../../../../src/services/runtimeController/conversations";

export const controllerClient = {
  core: { enabled: true },
  conversations: { listMessages: fetchConversationMessagesFromController },
  projects: {},
  agents: {},
  secrets: {},
  integrations: {},
  runtimes: {},
  providers: {},
  workspace: { files: { getRawUrl: () => null, read: async () => null }, git: {} },
};
