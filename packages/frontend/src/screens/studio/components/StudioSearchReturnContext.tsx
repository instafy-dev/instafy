import { createContext, useContext } from "react";

interface StudioSearchReturn {
  originToken: string | null;
  returnToResults: () => void;
}

const SearchReturnContext = createContext<StudioSearchReturn>({ originToken: null, returnToResults: () => {} });
export const StudioSearchReturnProvider = SearchReturnContext.Provider;
export function useStudioSearchReturn() { return useContext(SearchReturnContext); }
