import { describe, expect, it } from "vitest";
import { controllerClient, instafySdk } from "../index";
import { runtimeControllerEnabled } from "../../../services/runtimeControllerService";

describe("instafy sdk controller client", () => {
  it("exposes the grouped controller surface through the sdk entrypoint", () => {
    expect(instafySdk.controller).toBe(controllerClient);
    expect(controllerClient.core.enabled).toBe(runtimeControllerEnabled);
    expect(
      typeof Object.getOwnPropertyDescriptor(controllerClient.core, "baseUrl")?.get,
    ).toBe("function");
    expect(
      typeof Object.getOwnPropertyDescriptor(controllerClient.core, "enabled")?.get,
    ).toBe("function");
    expect(typeof controllerClient.core.resolveRequestContext).toBe("function");
    expect(typeof controllerClient.projects.create).toBe("function");
    expect(typeof controllerClient.projects.bootstrapMemory).toBe("function");
    expect(typeof controllerClient.conversations.sendMessage).toBe("function");
    expect(typeof controllerClient.conversations.resolveParticipation).toBe("function");
    expect(typeof controllerClient.runtimes.stopIfIdle).toBe("function");
    expect(typeof controllerClient.runtimes.setPreference).toBe("function");
    expect(typeof controllerClient.workspace.git.fetchStatus).toBe("function");
    expect(typeof controllerClient.workspace.git.fetchHistoryReview).toBe(
      "function",
    );
    expect(typeof controllerClient.workspace.files.delete).toBe("function");
    expect(typeof controllerClient.organizations.createInvitationStrict).toBe("function");
    expect(typeof controllerClient.notifications.listInbox).toBe("function");
    expect(typeof controllerClient.automations.runNow).toBe("function");
    expect(typeof controllerClient.skills.discover).toBe("function");
    expect(typeof controllerClient.secrets.createForProject).toBe("function");
    expect(typeof controllerClient.runs.subscribe).toBe("function");
    expect(typeof controllerClient.browserSessions.fetchPages).toBe("function");
    expect(typeof controllerClient.browserSessions.fetchPendingApproval).toBe("function");
    expect(typeof controllerClient.browserSessions.decideApproval).toBe("function");
  });
});
