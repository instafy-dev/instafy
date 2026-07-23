import { StudioLayout } from "../StudioLayout";
import { StudioProviders } from "./StudioProviders";

export default function StudioRoute() {
  return (
    <StudioProviders>
      <StudioLayout />
    </StudioProviders>
  );
}
