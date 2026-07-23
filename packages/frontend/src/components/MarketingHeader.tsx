import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { MarketingMobileNav, type MarketingMobileNavItem } from "./MarketingMobileNav";
import { MenuIcon } from "./marketingIcons";
import { OctoMark } from "./OctoMark";
import { Text } from "./Text";

// Deliberately react-aria-free: this header is in the landing page's eager
// bundle, and importing react-aria/iconoir here drags the whole vendor-ui
// chunk into the marketing first-load.

const MENU_LINK_BASE =
  "flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold transition";
const MENU_LINK_INACTIVE =
  "text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-slate-900/70 dark:hover:text-slate-50";
const MENU_LINK_ACTIVE =
  "bg-slate-100 text-slate-900 dark:bg-slate-900/80 dark:text-slate-50";
const MENU_PRIMARY =
  "inline-flex w-full items-center justify-center rounded-xl bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-primary-500/30 dark:focus-visible:ring-offset-slate-950";

function isActivePath(pathname: string, item: MarketingMobileNavItem) {
  const match = item.match ?? "exact";
  if (match === "prefix") {
    if (item.to === "/") return pathname === "/";
    return pathname === item.to || pathname.startsWith(`${item.to}/`);
  }
  return pathname === item.to;
}

export function MarketingHeader({ items }: { items: MarketingMobileNavItem[] }) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const primaryItem = useMemo(
    () => items.find((item) => (item.variant ?? "default") === "primary") ?? null,
    [items],
  );
  const navItems = useMemo(() => items.filter((item) => item !== primaryItem), [items, primaryItem]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4 md:py-6">
      <Link to="/" className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <OctoMark className="h-7 w-7 text-brand-ink dark:text-brand-paper" />
        <Text as="span" variant="display" tone="primary">
          Instafy
        </Text>
      </Link>

      <div className="ml-4 flex min-w-0 flex-1 justify-end">
        <div className="hidden w-full md:flex">
          <MarketingMobileNav inline align="end" items={items} />
        </div>

        <div ref={menuRef} className="relative md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((current) => !current)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300/60 dark:text-slate-200 dark:hover:bg-slate-900/70"
          >
            <MenuIcon className="h-5 w-5" aria-hidden="true" />
          </button>

          {menuOpen ? (
            <div className="absolute right-0 top-full z-50 mt-2.5 w-64 rounded-2xl border border-slate-200/70 bg-white p-2 shadow-modal dark:border-slate-800 dark:bg-slate-950">
              <nav aria-label="Marketing menu" className="flex flex-col gap-1">
                {navItems.map((item) => {
                  const active = isActivePath(location.pathname, item);
                  return (
                    <Link
                      key={`${item.to}:${item.label}`}
                      to={item.to}
                      onClick={() => setMenuOpen(false)}
                      className={[
                        MENU_LINK_BASE,
                        active ? MENU_LINK_ACTIVE : MENU_LINK_INACTIVE,
                      ].join(" ")}
                      data-testid={item.testId}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>

              {primaryItem ? (
                <div className="mt-2">
                  <Link
                    to={primaryItem.to}
                    onClick={() => setMenuOpen(false)}
                    className={MENU_PRIMARY}
                    data-testid={primaryItem.testId}
                  >
                    {primaryItem.label}
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
