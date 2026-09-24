export type LocalTabInput =
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string; shift: boolean };
export type LocalTabControlState = {
  type: "controlState";
  available: boolean;
  connectionId: string;
  grant: { id: string; connectionId: string; userId: string } | null;
  requested: boolean;
  requests?: { connectionId: string; userId: string }[];
};
export type LocalTabPublisherControl = {
  grant: (connectionId: string) => Promise<void>;
  revoke: () => Promise<void>;
  deny: (connectionId: string) => void;
};
export function readLocalTabControlState(
  value: unknown,
): LocalTabControlState | null {
  if (!value || typeof value !== "object") return null;
  const s = value as LocalTabControlState;
  return s.type === "controlState" &&
    typeof s.available === "boolean" &&
    typeof s.connectionId === "string" &&
    typeof s.requested === "boolean" &&
    (s.grant === null ||
      (s.grant &&
        typeof s.grant.id === "string" &&
        typeof s.grant.connectionId === "string" &&
        typeof s.grant.userId === "string")) &&
    (s.requests === undefined ||
      (Array.isArray(s.requests) &&
        s.requests.length <= 8 &&
        s.requests.every(
          (r) =>
            typeof r?.connectionId === "string" && typeof r.userId === "string",
        )))
    ? s
    : null;
}
