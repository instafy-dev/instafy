import { Suspense, lazy } from "react";

// The bridge reads the session and the controller client, which import the
// application's feature composition, and so this module: it loads once the
// Studio renders, never while the feature manifest is still being evaluated.
const ClaudeCodeAutoStartBridge = lazy(() => import("./ClaudeCodeAutoStartBridge"));

/**
 * Studio's own start of a space where a Claude Code turn of the person's
 * waits (docs/Local-Engine-Turns.md 11.14, D44), as a Studio runtime bridge:
 * see ClaudeCodeAutoStartBridge. It renders nothing.
 */
export function ClaudeCodeAutoStart() {
  return (
    <Suspense fallback={null}>
      <ClaudeCodeAutoStartBridge />
    </Suspense>
  );
}
