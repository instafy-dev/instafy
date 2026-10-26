import { KnoshRuntimePage } from "../KnoshRuntimePage";
import { StandaloneStudioProviders } from "@instafy/frontend/feature-api/ui";

export default function KnoshRuntimeRoute() {
  return (
    <StandaloneStudioProviders>
      <KnoshRuntimePage />
    </StandaloneStudioProviders>
  );
}
