import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../providers/AuthProvider";
import { Card } from "./Card";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-white to-slate-50 dark:bg-none dark:bg-slate-950">
        <Card
          tone="default"
          radius="3xl"
          shadow="none"
          padding="lg"
          className="border-white/60 bg-white/90 px-8 py-6 text-sm font-medium text-slate-600 shadow-xl dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-200"
        >
          Loading Instafy…
        </Card>
      </div>
    );
  }

  if (!user) {
    const redirectTarget = `${location.pathname}${location.search}`;
    const params = new URLSearchParams();
    params.set("redirect", redirectTarget);
    return <Navigate to={`/login?${params.toString()}`} replace />;
  }

  return <>{children}</>;
}
