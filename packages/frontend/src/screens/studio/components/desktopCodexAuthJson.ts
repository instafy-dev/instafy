import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "../../../lib/supabaseClient";
import { controllerBaseUrl } from "../../../sdk/instafy";

export type DesktopCodexCredentialConnectResult =
  | {
      success: true;
      credentialId: string;
      kind: "codex_auth_json";
      isDefault: boolean;
    }
  | { success: false; error: string };

export function canUseDesktopCodexAuthJson(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.instafyDesktop?.connectDefaultCodexAuthJson === "function"
  );
}

export function isLikelyDesktopDevice(): boolean {
  if (typeof window === "undefined" || Capacitor.isNativePlatform()) {
    return false;
  }
  try {
    const navigatorWithHints = window.navigator as Navigator & {
      userAgentData?: { mobile?: boolean; platform?: string };
    };
    const mobileOperatingSystem =
      navigatorWithHints.userAgentData?.mobile === true ||
      /Android|iPhone|iPad|iPod/i.test(navigatorWithHints.userAgentData?.platform ?? "") ||
      /Android|iPhone|iPad|iPod/i.test(navigatorWithHints.userAgent) ||
      (navigatorWithHints.platform === "MacIntel" && navigatorWithHints.maxTouchPoints > 1);
    if (mobileOperatingSystem) {
      return false;
    }
    const finePointer = window.matchMedia?.("(pointer: fine)")?.matches ?? false;
    const hover = window.matchMedia?.("(hover: hover)")?.matches ?? false;
    return finePointer || hover;
  } catch {
    return false;
  }
}

export function shouldPromptForCodexAuthJsonUpload(
  status: InstafyDesktopCodexAuthJsonStatus | null,
): boolean {
  // `null` also covers the initial probe, an older Desktop bridge, and a
  // failed status IPC call. In those cases the default importer remains the
  // safest action; only open the picker after Desktop explicitly reports that
  // the default file is missing.
  return status?.exists === false;
}

export function useDesktopCodexAuthJsonStatus(
  enabled: boolean,
): InstafyDesktopCodexAuthJsonStatus | null {
  const [status, setStatus] = useState<InstafyDesktopCodexAuthJsonStatus | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setStatus(null);
      return;
    }

    const bridge = window.instafyDesktop;
    if (typeof bridge?.codexAuthJsonStatus !== "function") {
      setStatus(null);
      return;
    }

    let cancelled = false;
    void bridge
      .codexAuthJsonStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return status;
}

export async function connectDesktopCodexAuthJson(options: {
  label?: string;
  makeDefault?: boolean;
} = {}): Promise<DesktopCodexCredentialConnectResult> {
  if (typeof window === "undefined") {
    return { success: false, error: "Desktop connect is unavailable." };
  }

  const bridge = window.instafyDesktop;
  if (typeof bridge?.connectDefaultCodexAuthJson !== "function") {
    return { success: false, error: "Desktop connect is unavailable." };
  }

  let hasVisibleSession = false;
  try {
    const result = await supabase.auth.getSession();
    hasVisibleSession = Boolean(
      result.data.session?.access_token && result.data.session.user?.id,
    );
  } catch {
    hasVisibleSession = false;
  }
  if (!hasVisibleSession || !controllerBaseUrl) {
    return { success: false, error: "Sign in to connect your local Codex login." };
  }

  try {
    const result = await bridge.connectDefaultCodexAuthJson({
      controllerUrl: controllerBaseUrl,
      label: options.label,
      makeDefault: options.makeDefault,
    });
    return { success: true, ...result };
  } catch {
    // IPC and network errors can contain implementation details. The native
    // bridge deliberately reports only a stable, secret-free failure here.
    return {
      success: false,
      error: "Unable to connect ~/.codex/auth.json from this computer.",
    };
  }
}
