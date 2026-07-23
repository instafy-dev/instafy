import type { ReactNode } from "react";
import { ConversationsProvider } from "../../conversations/ConversationsProvider";
import { WorkspaceUiProvider } from "../../workspace/useWorkspace";
import { WorkspaceTabsProvider } from "../../workspace/WorkspaceTabsProvider";
import { CodeProvider } from "../../code/useCode";
import { CreditsProvider } from "../../credits/useCredits";
import { RuntimeProvider } from "../../runtime/RuntimeProvider";
import { StatusProvider } from "../../status/StatusProvider";
import { RoadmapProvider } from "../../roadmap/RoadmapProvider";
import { BillingProvider } from "../../credits/BillingProvider";
import { ProjectMetadataProvider } from "../../projects/ProjectMetadataProvider";
import { ProjectAccessProvider } from "../../projects/ProjectAccessProvider";
import { ProjectStateProvider } from "../../projects/ProjectStateProvider";
import { RequireAuth } from "../../components/RequireAuth";
import { NativeExtensionRequestProvider } from "../../extensions/NativeExtensionRequestProvider";

export function StudioProviders({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <StatusProvider>
        <RoadmapProvider>
          <ProjectStateProvider>
            <ProjectMetadataProvider>
              <ProjectAccessProvider>
                <WorkspaceUiProvider>
                  <CodeProvider>
                    <BillingProvider>
                      <CreditsProvider>
                        <RuntimeProvider>
                          <NativeExtensionRequestProvider>
                            <ConversationsProvider>{children}</ConversationsProvider>
                          </NativeExtensionRequestProvider>
                        </RuntimeProvider>
                      </CreditsProvider>
                    </BillingProvider>
                  </CodeProvider>
                </WorkspaceUiProvider>
              </ProjectAccessProvider>
            </ProjectMetadataProvider>
          </ProjectStateProvider>
        </RoadmapProvider>
      </StatusProvider>
    </RequireAuth>
  );
}

export function StandaloneStudioProviders({ children }: { children: ReactNode }) {
  return (
    <StudioProviders>
      <WorkspaceTabsProvider>{children}</WorkspaceTabsProvider>
    </StudioProviders>
  );
}
