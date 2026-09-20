import { RobotLabPage } from "../RobotLabPage";
import {
  ProviderBindingApprovalHost,
  StandaloneStudioProviders,
} from "@instafy/frontend/feature-api/ui";

export default function RobotLabRoute() {
  return (
    <StandaloneStudioProviders>
      <ProviderBindingApprovalHost />
      <RobotLabPage />
    </StandaloneStudioProviders>
  );
}
