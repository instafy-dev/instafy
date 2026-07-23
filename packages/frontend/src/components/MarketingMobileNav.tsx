import { Link, useLocation } from "react-router-dom";

export type MarketingMobileNavItem = {
  label: string;
  to: string;
  match?: "exact" | "prefix";
  variant?: "default" | "primary";
  testId?: string;
};

const BASE =
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-4 py-2.5 text-xs font-semibold leading-none transition";
const INACTIVE =
  "border-slate-200/70 bg-white/60 text-slate-700 hover:bg-white hover:text-slate-900 dark:border-slate-800/70 dark:bg-slate-950/50 dark:text-slate-200 dark:hover:bg-slate-950/80 dark:hover:text-slate-50";
const ACTIVE =
  "border-slate-400/80 bg-white/60 text-slate-900 ring-1 ring-inset ring-black/5 dark:border-slate-600/80 dark:bg-slate-950/50 dark:text-slate-50 dark:ring-white/10";
const PRIMARY =
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-primary-600 px-4 py-2.5 text-xs font-semibold leading-none text-white transition hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-primary-500/30 dark:focus-visible:ring-offset-slate-950";

function isActivePath(pathname: string, item: MarketingMobileNavItem) {
  const match = item.match ?? "exact";
  if (match === "prefix") {
    if (item.to === "/") return pathname === "/";
    return pathname === item.to || pathname.startsWith(`${item.to}/`);
  }
  return pathname === item.to;
}

export function MarketingMobileNav({
  items,
  inline = false,
  align = "start",
  className,
}: {
  items: MarketingMobileNavItem[];
  inline?: boolean;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const location = useLocation();

  const justifyClass =
    align === "end" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";

  const links = items.map((item) => {
    const active = isActivePath(location.pathname, item);
    const variant = item.variant ?? "default";
    const linkClassName = variant === "primary" ? PRIMARY : [BASE, active ? ACTIVE : INACTIVE].join(" ");
    return (
      <Link
        key={`${item.to}:${item.label}`}
        to={item.to}
        className={linkClassName}
        data-testid={item.testId}
      >
        {item.label}
      </Link>
    );
  });

  if (inline) {
    return (
      <nav className={["flex w-full flex-nowrap items-center gap-2 overflow-x-auto", justifyClass, className]
        .filter(Boolean)
        .join(" ")}>
        {links}
      </nav>
    );
  }

  return (
    <nav className="mx-auto w-full max-w-6xl px-6 pb-2">
      <div className={["flex items-center gap-2 overflow-x-auto pb-2", justifyClass, className].filter(Boolean).join(" ")}>
        {links}
      </div>
    </nav>
  );
}
