import type { ReactNode } from "react";
import { NavArrowDown, Xmark } from "iconoir-react";
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
    {scope !== "all" ? <span className="studio-scope-picker-chip">
      {context.team}
      <button type="button" className="studio-scope-remove" aria-label="Search all orgs" title="Search all orgs" onClick={() => onBroaden("all", true)}><Xmark aria-hidden="true" /></button>
    </span> : <button type="button" className="studio-search-all studio-all-scope-picker" aria-label="Choose team or space" onClick={context.onBrowseTeams}>All orgs<NavArrowDown aria-hidden="true" /></button>}
    {scope === "space" ? <>
      <span className="studio-search-separator" aria-hidden="true">/</span>
      <span className="studio-scope-picker-chip">
        {context.space}
        <button type="button" className="studio-scope-remove" aria-label={`Search within ${context.teamName}`} title={`Search within ${context.teamName}`} onClick={() => onBroaden("org", true)}><Xmark aria-hidden="true" /></button>
      </span>
    </> : null}
  </span>;
}
