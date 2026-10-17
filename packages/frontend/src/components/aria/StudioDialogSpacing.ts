import { createContext, useContext } from "react";

export type StudioDialogGutter = "default" | "responsive";

/** Existing dialogs keep 20px gutters until all their sections opt in together. */
export const StudioDialogGutterContext = createContext<StudioDialogGutter>("default");

export function useStudioDialogGutterClass() {
  return useContext(StudioDialogGutterContext) === "responsive" ? "px-4 sm:px-5" : "px-5";
}
