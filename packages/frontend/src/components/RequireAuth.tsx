import { parseNotificationClickUrl } from "../notifications/notificationContract";
import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../providers/AuthProvider";
import { EntryLoadingScreen } from "./EntryLoadingScreen";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <EntryLoadingScreen />;
  }

  if (!user) {
    const redirectTarget = `${location.pathname}${location.search}`;
    const params = new URLSearchParams();
    params.set("redirect", redirectTarget);
    return <Navigate to={`/login?${params.toString()}`} replace />;
  }

  // A notification clicked before login may belong to a different remembered
  // account. Reject it before Studio/providers can consume project/report IDs.
  const notificationClick = parseNotificationClickUrl(`${location.pathname}${location.search}`);
  if (notificationClick && notificationClick.accountId !== user.id) {
    return <Navigate to="/studio" replace />;
  }

  return <>{children}</>;
}
