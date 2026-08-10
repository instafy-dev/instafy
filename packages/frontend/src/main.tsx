import "./debug/installAppLogCapture";
import React from "react";
import ReactDOM from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import "./styles/tailwind.css";
import { router } from "./applicationRouter";
import { AuthProvider } from "./providers/AuthProvider";
import { ProfileProvider } from "./profile/ProfileProvider";
import { ThemeProvider } from "./theme/ThemeProvider";
import { installDesktopUpdateBootstrap } from "./desktop/updates/bootstrap";
import { installDesktopWindowChromeBootstrap } from "./desktop/windowChrome/bootstrap";
import { installNativeOtaBootstrap } from "./mobile/ota/bootstrap";
import { installNativeDeepLinkBootstrap } from "./native/nativeDeepLinks";

const NOTIFICATIONS_DEBUG_STORAGE_KEY = "instafy.notifications.debug";
const SW_PUSH_DEBUG_EVENT = "instafy:sw-push-debug";

function notificationsDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(NOTIFICATIONS_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function installServiceWorkerPushDebugListener() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event) => {
    const payload = event.data as { type?: unknown } | undefined;
    if (!payload || payload.type !== SW_PUSH_DEBUG_EVENT) {
      return;
    }
    if (!notificationsDebugEnabled()) {
      return;
    }
    console.info("[notifications][sw]", payload);
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
});

if (Capacitor.isNativePlatform()) {
  void (async () => {
    try {
      const { StatusBar } = await import("@capacitor/status-bar");
      await StatusBar.setOverlaysWebView({ overlay: false });
    } catch {
      // Static Capacitor config handles current binaries; retain this fallback for older OTA shells.
    }
  })();
}

if (import.meta.env.PROD && typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
}

installServiceWorkerPushDebugListener();
installDesktopUpdateBootstrap();
installDesktopWindowChromeBootstrap();
void installNativeOtaBootstrap();
installNativeDeepLinkBootstrap(router);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ProfileProvider>
            <RouterProvider router={router} />
          </ProfileProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
