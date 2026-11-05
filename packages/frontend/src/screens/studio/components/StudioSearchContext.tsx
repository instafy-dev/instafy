import type { ReactNode } from "react";
import { NavArrowDown, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioSearchScopeChip } from "./StudioSearchScopeChip";
import type { StudioSearchScope } from "./useStudioSearch";
import "./StudioSearchContext.css";

export interface StudioNavigationContext {
  team: ReactNode;
  space: ReactNode;
  teamName: string;
  accentColor?: string | null;
  onBrowseTeams: () => void;
}

/** Reuses the navigation owner's pickers; removing a chip only changes search scope. */
export function StudioSearchContext({ scope, context, onBroaden }: {
  scope: StudioSearchScope;
  context: StudioNavigationContext;
  onBroaden: (scope: StudioSearchScope, focusInput?: boolean) => void;
}) {
  return <span className="studio-search-context" data-testid="studio-search-context" onClick={event => event.stopPropagation()}>
    {scope !== "all" ? <StudioSearchScopeChip className="studio-scope-picker-chip">
      {context.team}
      <IconButton variant="ghost" tone="muted" size="xs" className="studio-scope-remove" aria-label="Search all orgs" title="Search all orgs" onPress={() => onBroaden("all", true)}><Xmark aria-hidden="true" /></IconButton>
    </StudioSearchScopeChip> : <Button variant="secondary" size="xs" radius="lg" elevation="none" className="studio-all-scope-picker" aria-label="Choose team or space" onPress={context.onBrowseTeams}>All orgs<NavArrowDown aria-hidden="true" /></Button>}
    {scope === "space" ? <>
      <Text as="span" variant="caption" tone="subtle" className="studio-search-separator" aria-hidden="true">/</Text>
      <StudioSearchScopeChip className="studio-scope-picker-chip">
        {context.space}
        <IconButton variant="ghost" tone="muted" size="xs" className="studio-scope-remove" aria-label={`Search within ${context.teamName}`} title={`Search within ${context.teamName}`} onPress={() => onBroaden("org", true)}><Xmark aria-hidden="true" /></IconButton>
      </StudioSearchScopeChip>
    </> : null}
  </span>;
}
