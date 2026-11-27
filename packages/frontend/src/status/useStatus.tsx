import { useContext } from "react";
import {
  StatusContext,
  type StatusContextValue,
  type StatusIntent,
} from "./StatusProvider";

const fallback: StatusContextValue = {
  queue: null,
  showStatus: () => {},
  hideStatus: () => {}
};

export function useStatus(): StatusContextValue {
  return useContext(StatusContext) ?? fallback;
}

export type { StatusIntent };
