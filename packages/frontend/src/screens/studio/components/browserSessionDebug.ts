export type BrowserSessionWsDebugFields = {
  wsUrlHost: string;
  wsUrlPath: string;
};

/**
 * Return only non-secret websocket location fields for runtime diagnostics.
 * Browser-session websocket query parameters carry credentials and must never
 * be copied into client debug logs.
 */
export function browserSessionWsDebugFields(wsUrl: string): BrowserSessionWsDebugFields {
  try {
    const parsed = new URL(wsUrl);
    return {
      wsUrlHost: parsed.host,
      wsUrlPath: parsed.pathname,
    };
  } catch {
    return {
      wsUrlHost: "invalid",
      wsUrlPath: "invalid",
    };
  }
}
