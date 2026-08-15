import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  ScrollRestoration,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { LandingPage } from "./screens/LandingPage";
import { InstallPage } from "./screens/InstallPage";
import { NewsPage } from "./screens/NewsPage";
import { NewsPostPage } from "./screens/NewsPostPage";
import { TermsPage } from "./screens/TermsPage";
import { PrivacyPage } from "./screens/PrivacyPage";
import { RouteErrorPage } from "./screens/RouteErrorPage";
import { RequireAuth } from "./components/RequireAuth";
import {
  subscribeToControllerReloadRequired,
} from "./services/runtimeController/core";
import type { FrontendFeatureComposition } from "./features/frontendFeatureModule";

// The studio (and everything that pulls its provider graph) is code-split so
// the marketing pages don't download the whole app. Route modules under
// ./screens/routes bundle each page together with its providers.
const StudioRoute = lazy(() => import("./screens/routes/StudioRoute"));
const LoginPage = lazy(() =>
  import("./screens/LoginPage").then((module) => ({ default: module.LoginPage })),
);
const InviteAcceptPage = lazy(() =>
  import("./screens/InviteAcceptPage").then((module) => ({ default: module.InviteAcceptPage })),
);
const CliLoginPage = lazy(() =>
  import("./screens/CliLoginPage").then((module) => ({ default: module.CliLoginPage })),
);
const ProviderSurfaceSandboxPage = lazy(() =>
  import("./screens/ProviderSurfaceSandboxPage").then((module) => ({
    default: module.ProviderSurfaceSandboxPage,
  })),
);
const StatusProviderLazy = lazy(() =>
  import("./status/StatusProvider").then((module) => ({ default: module.StatusProvider })),
);

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-white to-[#efefef] dark:bg-none dark:bg-slate-950">
      <div className="rounded-3xl border border-white/60 bg-white/90 px-8 py-6 text-sm font-medium text-slate-600 shadow-xl dark:border-slate-800 dark:bg-slate-950/70 dark:text-slate-300">
        Loading Instafy…
      </div>
    </div>
  );
}

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

function ScrollToHash() {
  const location = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === "POP") {
      return;
    }

    if (!location.hash) {
      window.scrollTo({ top: 0, left: 0 });
      return;
    }

    const targetId = decodeURIComponent(location.hash.replace(/^#/, ""));
    const target = document.getElementById(targetId);
    if (!target) {
      window.scrollTo({ top: 0, left: 0 });
      return;
    }

    target.scrollIntoView({ block: "start" });
  }, [location.hash, location.pathname, location.search, navigationType]);

  return null;
}

function AppShell() {
  const controllerReloadAttemptedRef = useRef(false);

  useEffect(() => {
    const reload = () => {
      if (controllerReloadAttemptedRef.current) {
        return;
      }
      controllerReloadAttemptedRef.current = true;
      try {
        window.location.reload();
      } catch (_error) {
        // Some embedded/test location implementations cannot reload. Core
        // keeps the current document binding immutable and blocks new token
        // resolution while the reload remains pending.
      }
    };
    return subscribeToControllerReloadRequired(reload);
  }, []);

  return (
    <>
      <ScrollRestoration />
      <ScrollToHash />
      <Outlet />
    </>
  );
}

const CORE_ROUTE_PATHS = new Set([
  "install",
  "provider-sandbox/:providerId/:surfaceId",
  "news",
  "news/:slug",
  "login",
  "terms",
  "privacy",
  "invite",
  "cli/login",
  "studio",
]);

export function createInstafyRouter(
  featureComposition: FrontendFeatureComposition,
) {
  for (const route of featureComposition.routes) {
    if (CORE_ROUTE_PATHS.has(route.path)) {
      throw new Error(`Frontend feature route path "${route.path}" conflicts with a core route.`);
    }
  }

  return createBrowserRouter([
    {
      path: "/",
      element: <AppShell />,
      errorElement: <RouteErrorPage />,
      children: [
        {
          index: true,
          element: Capacitor.isNativePlatform() ? (
            <Navigate to="/studio" replace />
          ) : (
            <LandingPage />
          ),
        },
        {
          path: "install",
          element: <InstallPage />,
        },
        ...featureComposition.routes.map((route) => ({
          path: route.path,
          element: <LazyRoute>{route.element}</LazyRoute>,
        })),
        {
          path: "provider-sandbox/:providerId/:surfaceId",
          element: (
            <LazyRoute>
              <ProviderSurfaceSandboxPage />
            </LazyRoute>
          ),
        },
        {
          path: "news",
          element: <NewsPage />,
        },
        {
          path: "news/:slug",
          element: <NewsPostPage />,
        },
        {
          path: "login",
          element: (
            <LazyRoute>
              <LoginPage />
            </LazyRoute>
          ),
        },
        {
          path: "terms",
          element: <TermsPage />,
        },
        {
          path: "privacy",
          element: <PrivacyPage />,
        },
        {
          path: "invite",
          element: (
            <LazyRoute>
              <RequireAuth>
                <StatusProviderLazy>
                  <InviteAcceptPage />
                </StatusProviderLazy>
              </RequireAuth>
            </LazyRoute>
          ),
        },
        {
          path: "cli/login",
          element: (
            <LazyRoute>
              <RequireAuth>
                <CliLoginPage />
              </RequireAuth>
            </LazyRoute>
          ),
        },
        {
          path: "studio",
          element: (
            <LazyRoute>
              <StudioRoute />
            </LazyRoute>
          ),
        },
      ],
    },
  ]);
}
