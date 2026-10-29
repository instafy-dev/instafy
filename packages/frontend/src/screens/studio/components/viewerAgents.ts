import { createContext } from "react";
import type { SavedAgentFace } from "../../../utils/aiFace";

/**
 * The viewer's own saved agents (GET /me/agents) by agent id, so every chat
 * face of one of them is drawn from its current profile (withSavedAgentFace)
 * rather than the seed an older row was stamped with. Other people's agents
 * are not in it and keep their stamps. An AI known only by its handle (a
 * thread's owner before its first row) is looked up here by handle. ChatPanel
 * provides it; outside a chat it is empty.
 */
export const ViewerAgentsContext = createContext<ReadonlyMap<string, SavedAgentFace>>(new Map());
