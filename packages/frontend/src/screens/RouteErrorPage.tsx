import { useEffect, useMemo } from "react";
import { Link, isRouteErrorResponse, useLocation, useNavigate, useRouteError } from "react-router-dom";
import { applyPageMeta } from "../utils/seo";

function resolveRouteError(error: unknown) {
  if (isRouteErrorResponse(error)) {
    return {
      status: error.status,
      title: error.status === 404 ? "Page not found" : "Navigation failed",
      detail:
        error.status === 404
          ? "That route does not exist in Instafy."
          : error.statusText || "The app could not finish loading this route.",
    };
  }

  if (error instanceof Error) {
    return {
      status: null,
      title: "Navigation failed",
      detail: error.message || "The app could not finish loading this route.",
    };
  }

  return {
    status: null,
    title: "Navigation failed",
    detail: "The app could not finish loading this route.",
  };
}

export function RouteErrorPage() {
  const error = useRouteError();
  const location = useLocation();
  const navigate = useNavigate();
  const routeError = useMemo(() => resolveRouteError(error), [error]);
  const pathLabel = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    applyPageMeta({
      title: `${routeError.status === 404 ? "404" : "Navigation error"} | Instafy`,
      description: "Instafy could not open this route.",
    });
  }, [routeError.status]);

  return (
    <main className="min-h-screen bg-white text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <section className="w-full max-w-xl px-6 pb-16 pt-24 sm:px-10 sm:pt-32">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
          {routeError.status ? routeError.status : "Error"}
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">{routeError.title}</h1>
        <p className="mt-3 text-base leading-7 text-slate-600 dark:text-slate-300">{routeError.detail}</p>
        <p className="mt-5 break-all font-mono text-sm text-slate-400 dark:text-slate-500">{pathLabel}</p>

        <div className="mt-8 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200/70 px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300/60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-white/10 dark:hover:text-white"
          >
            Go back
          </button>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-xl px-3.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            Home
          </Link>
        </div>
      </section>
    </main>
  );
}
