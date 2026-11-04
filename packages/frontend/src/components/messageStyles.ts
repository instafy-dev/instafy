import { DARK_MESSAGE_BG_CLASS } from "../theme/darkSurfaces";

/** Own messages read as filled prose; alignment identifies the sender.
 * Shared by Studio and its landing demo, independently of control styling. */
export const OWN_MESSAGE_BUBBLE_CLASS =
  `rounded-2xl bg-slate-100 px-3.5 py-2.5 text-slate-800 ${DARK_MESSAGE_BG_CLASS} dark:text-slate-200`;
