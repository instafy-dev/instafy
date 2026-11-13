import { resolveTrustedDesktopControllerOrigin } from "./codexCredentialBridge";

const PINNED_DESKTOP_CONTROLLER_ORIGIN = "https://controller.instafy.dev";

export type DesktopControllerStartKind = "runtime" | "speech_tunnel";
export type DesktopControllerStartCredentialMode = "ambient" | "fixed";

export type ResolveTrustedDesktopControllerStartOptions = {
  appUrl: string;
  callerUrl: string;
  requestedControllerUrl: string;
  isPackaged: boolean;
  startKind: DesktopControllerStartKind;
  credentialMode: DesktopControllerStartCredentialMode;
};

export type DesktopControllerVisibleSessionIdentity = {
  accessToken: string;
  userId: string;
};

export type DesktopControllerStartCredentialProvenance =
  | { kind: "fixed" }
  | { kind: "ambient"; userId: string };

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Resolve a renderer-selected controller before native code gives a runtime or
 * speech tunnel its bearer. Packaged Desktop is pinned to Instafy's production
 * controller; unpackaged Desktop supports only loopback development
 * controllers. The policy intentionally does not vary by credential mode.
 */
export function resolveTrustedDesktopControllerForStart(
  options: ResolveTrustedDesktopControllerStartOptions,
): string {
  const controllerOrigin = resolveTrustedDesktopControllerOrigin(
    options.appUrl,
    options.callerUrl,
    options.requestedControllerUrl,
  );
  const startLabel =
    options.startKind === "speech_tunnel" ? "Desktop speech tunnel" : "Desktop runtime";
  const credentialLabel = options.credentialMode === "ambient" ? "ambient" : "fixed";

  if (options.isPackaged) {
    if (controllerOrigin !== PINNED_DESKTOP_CONTROLLER_ORIGIN) {
      throw new Error(
        `${startLabel} ${credentialLabel} credentials require the pinned Instafy controller in packaged Desktop.`,
      );
    }
    return controllerOrigin;
  }

  if (!isLoopbackHostname(new URL(controllerOrigin).hostname)) {
    throw new Error(
      `${startLabel} ${credentialLabel} credentials require a loopback controller in development.`,
    );
  }
  return controllerOrigin;
}

/**
 * The controller a Desktop extension call speaks for, under the same trust
 * policy as a runtime start. The renderer may name it; otherwise packaged
 * Desktop uses its pinned controller, and an unpackaged build the one its
 * running runtime was started against. Null when none is known or trusted;
 * a controller the renderer names but the policy refuses is an error.
 */
export function resolveTrustedDesktopControllerForExtension(options: {
  appUrl: string;
  callerUrl: string;
  requestedControllerUrl: string | null;
  runningRuntimeControllerUrl: string | null;
  isPackaged: boolean;
}): string | null {
  const resolve = (requestedControllerUrl: string) =>
    resolveTrustedDesktopControllerForStart({
      appUrl: options.appUrl,
      callerUrl: options.callerUrl,
      requestedControllerUrl,
      isPackaged: options.isPackaged,
      startKind: "runtime",
      credentialMode: "ambient",
    });
  const requested = options.requestedControllerUrl?.trim();
  if (requested) {
    return resolve(requested);
  }
  const fallback = options.isPackaged
    ? PINNED_DESKTOP_CONTROLLER_ORIGIN
    : options.runningRuntimeControllerUrl?.trim();
  if (!fallback) {
    return null;
  }
  try {
    return resolve(fallback);
  } catch {
    return null;
  }
}

/**
 * Ambient starts are allowed to retain refreshable session provenance only
 * when the renderer-supplied bearer is the exact token of the currently
 * visible, validated user. Fixed credentials do not consult renderer session
 * state after their controller origin has passed the trust policy above.
 */
export function assertDesktopControllerStartSessionBinding(options: {
  credentialMode: DesktopControllerStartCredentialMode;
  controllerAccessToken: string;
  visibleSession: DesktopControllerVisibleSessionIdentity | null;
}): void {
  if (options.credentialMode !== "ambient") {
    return;
  }
  if (
    !options.visibleSession?.userId.trim() ||
    options.controllerAccessToken !== options.visibleSession.accessToken
  ) {
    throw new Error("The Desktop controller session changed. Sign in again and retry.");
  }
}

/**
 * The Instafy user a runtime start is bound to: the visible session's user,
 * when Studio asked for ambient credentials and the start's bearer is that
 * session's own token. Unlike the credential provenance below, this holds in
 * unpackaged builds too, where the credential itself stays fixed. A start
 * that asked for fixed credentials is bound to nobody.
 */
export function resolveDesktopControllerStartBoundUserId(options: {
  credentialMode: DesktopControllerStartCredentialMode;
  controllerAccessToken: string;
  visibleSession: DesktopControllerVisibleSessionIdentity | null;
}): string | null {
  if (options.credentialMode !== "ambient") {
    return null;
  }
  assertDesktopControllerStartSessionBinding(options);
  return options.visibleSession?.userId.trim().toLowerCase() || null;
}

export function resolveDesktopControllerStartCredentialProvenance(options: {
  credentialMode: DesktopControllerStartCredentialMode;
  controllerAccessToken: string;
  visibleSession: DesktopControllerVisibleSessionIdentity | null;
  allowAmbientRefresh: boolean;
}): DesktopControllerStartCredentialProvenance {
  if (options.credentialMode !== "ambient") {
    return { kind: "fixed" };
  }
  assertDesktopControllerStartSessionBinding(options);
  if (!options.allowAmbientRefresh) {
    return { kind: "fixed" };
  }
  return {
    kind: "ambient",
    userId: options.visibleSession?.userId.trim() ?? "",
  };
}
