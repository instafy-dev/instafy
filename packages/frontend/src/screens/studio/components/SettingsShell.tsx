import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type FocusEvent, type ReactNode } from "react";
import { MenuTrigger } from "react-aria-components";
import { ControlChevron } from "../../../components/ControlChevron";
import { Button } from "../../../components/Button";
import { pickerListRowTextClassName } from "../../../components/listRowStyles";
import { EntityRow } from "../../../components/EntityRow";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";

export type SettingsCategory = {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  disabled?: boolean;
  danger?: boolean;
  testId?: string;
  children?: SettingsCategory[];
};

interface SettingsShellProps {
  title: string;
  titleVisibility?: "always" | "desktop";
  subtitle?: string;
  subtitleVisibility?: "always" | "desktop";
  hideTitle?: boolean;
  scope?: ReactNode;
  scopeVisibility?: "always" | "desktop";
  actions?: ReactNode;
  categories?: SettingsCategory[];
  activeCategoryId?: string;
  onCategoryChange?: (categoryId: string) => void;
  activeChildCategoryId?: string | null;
  onChildCategoryChange?: (categoryId: string) => void;
  children: ReactNode;
  className?: string;
  navLabel?: string;
  testId?: string;
  navTestId?: string;
  /** A small, flat category set can remain visible when a sidebar won't fit. */
  compactCategoryNavigation?: "picker" | "tabs";
}

export function SettingsShell({
  title,
  titleVisibility = "always",
  subtitle,
  subtitleVisibility = "always",
  hideTitle = false,
  scope,
  scopeVisibility = "always",
  actions,
  categories,
  activeCategoryId,
  onCategoryChange,
  activeChildCategoryId,
  onChildCategoryChange,
  children,
  className,
  navLabel = "Categories",
  testId = "settings-shell",
  navTestId = "settings-category-nav",
  compactCategoryNavigation = "picker",
}: SettingsShellProps) {
  const isLargeScreen = useStudioDesktopLayout();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [hasWideContainer, setHasWideContainer] = useState(false);
  const navigationFocusRef = useRef<HTMLElement | null>(null);
  const wideContainerRef = useRef(false);
  const useSideNavigation = isLargeScreen && hasWideContainer;
  const useCompactTabs = compactCategoryNavigation === "tabs" && Boolean(categories?.length && categories.length <= 3 && categories.every(category => !category.children?.length));

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const syncWidth = () => {
      // Reserve enough room for useful form fields beside the category list.
      // The viewport alone does not account for Studio's open side panels.
      const wide = shell.getBoundingClientRect().width >= 768;
      if (wide === wideContainerRef.current) return;
      wideContainerRef.current = wide;
      setHasWideContainer(wide);
    };
    syncWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncWidth);
      return () => window.removeEventListener("resize", syncWidth);
    }
    const observer = new ResizeObserver(syncWidth);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  const hasCategories = Boolean(categories && categories.length > 0 && activeCategoryId && onCategoryChange);
  const showTitle = !hideTitle && (titleVisibility === "always" || isLargeScreen);
  const subtitleAllowed = subtitleVisibility === "always" || isLargeScreen;
  const scopeAllowed = scopeVisibility === "always" || isLargeScreen;
  const showSubtitle = Boolean(
    subtitle &&
      subtitleAllowed &&
      (!isLargeScreen || hideTitle) &&
      !(hasCategories && (!isLargeScreen || !hideTitle)),
  );
  const showScope = Boolean(scope && scopeAllowed);
  const showHeader = showTitle || showSubtitle || showScope || Boolean(actions);
  const mobileCategoryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileChildTriggerRef = useRef<HTMLButtonElement | null>(null);
  const handleNavigationFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    navigationFocusRef.current = event.target;
  }, []);
  const handleNavigationBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    // A user leaving navigation must not be pulled back by a later resize.
    // Removal during a presentation change is handled by the layout effect.
    if (event.target.isConnected) navigationFocusRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const previousFocus = navigationFocusRef.current;
    if (!previousFocus || previousFocus.isConnected) return;
    navigationFocusRef.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (useSideNavigation || useCompactTabs) {
      const navigation = shellRef.current?.querySelector("[data-settings-navigation]");
      const selectedPage = navigation?.querySelector<HTMLButtonElement>('[aria-current="page"]:not(:disabled)');
      const selectedLocation = navigation?.querySelector<HTMLButtonElement>('[aria-current="location"]:not(:disabled)');
      (selectedPage ?? selectedLocation)?.focus();
    } else {
      (mobileChildTriggerRef.current ?? mobileCategoryTriggerRef.current)?.focus();
    }
  }, [useCompactTabs, useSideNavigation]);

  const desktopNavContent = useMemo(() => {
    if (!hasCategories || !categories) {
      return null;
    }
    return (
      <div className="space-y-1">
        {categories.map((category) => {
          const active = category.id === activeCategoryId;
          const Icon = category.icon;
          return (
            <div key={category.id} className="space-y-1">
              <EntityRow
                title={category.label}
                start={Icon ? <Icon className="h-4 w-4" aria-hidden={true} /> : null}
                onPress={() => onCategoryChange?.(category.id)}
                pressable
                isDisabled={category.disabled}
                data-testid={category.testId ?? `settings-category-${category.id}`}
                aria-current={active ? (category.children?.length ? "location" : "page") : undefined}
                titleClassName={category.danger
                  ? "!text-rose-600 dark:!text-rose-400"
                  : pickerListRowTextClassName(active)}
                surface={active ? "selected" : "interactive"}
                density="compact"
                className={[
                  "min-h-10",
                  active
                    ? "focus-visible:!border-primary-300 focus-visible:!ring-0 focus-visible:!ring-offset-0 dark:focus-visible:!border-primary-500/70"
                    : "",
                  category.danger && !active
                    ? "text-rose-600 dark:text-rose-400"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              {active && category.children && category.children.length > 0 && onChildCategoryChange ? (
                <div className="ml-3 space-y-1">
                  {category.children.map((child) => (
                    <EntityRow
                      key={`${category.id}:${child.id}`}
                      onPress={() => onChildCategoryChange(child.id)}
                      title={child.label}
                      pressable
                      isDisabled={child.disabled}
                      data-testid={child.testId ?? `settings-category-${category.id}-${child.id}`}
                      aria-current={child.id === activeChildCategoryId ? "page" : undefined}
                      titleClassName={pickerListRowTextClassName(child.id === activeChildCategoryId)}
                      surface={child.id === activeChildCategoryId ? "selected" : "interactive"}
                      density="compact"
                      className={[
                        "min-h-9",
                        child.id === activeChildCategoryId
                          ? "focus-visible:!border-primary-300 focus-visible:!ring-0 focus-visible:!ring-offset-0 dark:focus-visible:!border-primary-500/70"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }, [activeCategoryId, activeChildCategoryId, categories, hasCategories, onCategoryChange, onChildCategoryChange]);

  const mobileNavContent = useMemo(() => {
    if (!hasCategories || !categories || useSideNavigation) {
      return null;
    }
    const activeCategory = categories.find((category) => category.id === activeCategoryId) ?? categories[0] ?? null;
    if (!activeCategory) {
      return null;
    }
    if (useCompactTabs) {
      return (
        <div className={`flex min-w-0 gap-1 border-b border-slate-200 ${DARK_DIVIDER_BORDER_CLASS}`} data-testid={`${navTestId}-tabs`}>
          {categories.map(category => {
            const active = category.id === activeCategoryId;
            return (
              <Button
                key={category.id}
                type="button"
                variant="ghost"
                size="sm"
                radius="none"
                isDisabled={category.disabled}
                onPress={() => onCategoryChange?.(category.id)}
                aria-current={active ? "page" : undefined}
                data-testid={category.testId ?? `settings-category-${category.id}`}
                className={[
                  "-mb-px min-h-11 min-w-0 flex-1 whitespace-nowrap border-b-2 !px-2",
                  pickerListRowTextClassName(active),
                  active
                    ? "border-primary-500 dark:border-primary-400"
                    : "border-transparent",
                ].join(" ")}
              >
                {category.label}
              </Button>
            );
          })}
        </div>
      );
    }
    return (
      <MenuTrigger>
        <EntityRow
          ref={mobileCategoryTriggerRef}
          title={activeCategory.label}
          start={
            activeCategory.icon ? (
              <activeCategory.icon className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden={true} />
            ) : null
          }
          end={<ControlChevron />}
          pressable
          isDisabled={categories.every((category) => category.disabled)}
          data-testid={`${navTestId}-picker`}
          surface="outlined"
          density="compact"
          className="min-h-10"
          aria-label={`${navLabel}: ${activeCategory.label}`}
        />
        <StudioPopover
          triggerRef={mobileCategoryTriggerRef}
          placement="bottom start"
          offset={6}
          className="min-w-[var(--trigger-width)] p-2"
        >
          <StudioMenu
            aria-label={navLabel}
            selectionMode="single"
            selectedKeys={activeCategoryId ? [activeCategoryId] : []}
            onAction={(key) => onCategoryChange?.(String(key))}
          >
            {categories.map((category) => {
              const Icon = category.icon;
              return (
                <StudioMenuItem
                  key={category.id}
                  id={category.id}
                  data-testid={category.testId ?? `settings-category-${category.id}`}
                  isDisabled={category.disabled}
                >
                  <span className="flex items-center gap-2">
                    {Icon ? <Icon className="h-4 w-4" aria-hidden={true} /> : null}
                    <span>{category.label}</span>
                  </span>
                </StudioMenuItem>
              );
            })}
          </StudioMenu>
        </StudioPopover>
      </MenuTrigger>
    );
  }, [
    activeCategoryId,
    categories,
    hasCategories,
    useSideNavigation,
    useCompactTabs,
    navLabel,
    navTestId,
    onCategoryChange,
  ]);

  const mobileChildNavContent = useMemo(() => {
    if (!hasCategories || !categories || useSideNavigation || !activeCategoryId || !onChildCategoryChange) {
      return null;
    }
    const activeCategory = categories.find((category) => category.id === activeCategoryId) ?? null;
    if (!activeCategory?.children || activeCategory.children.length === 0) {
      return null;
    }
    const activeChildCategory =
      activeCategory.children.find((child) => child.id === activeChildCategoryId) ??
      activeCategory.children[0] ??
      null;
    if (!activeChildCategory) {
      return null;
    }
    return (
      <MenuTrigger>
        <EntityRow
          ref={mobileChildTriggerRef}
          title={activeChildCategory.label}
          end={<ControlChevron />}
          pressable
          isDisabled={activeCategory.children.every((child) => child.disabled)}
          data-testid={`${navTestId}-child-picker`}
          surface="outlined"
          density="compact"
          className="min-h-10"
          aria-label={`${activeCategory.label} section`}
        />
        <StudioPopover
          triggerRef={mobileChildTriggerRef}
          placement="bottom start"
          offset={6}
          className="min-w-[var(--trigger-width)] p-2"
        >
          <StudioMenu
            aria-label={`${activeCategory.label} sections`}
            selectionMode="single"
            selectedKeys={activeChildCategoryId ? [activeChildCategoryId] : []}
            onAction={(key) => onChildCategoryChange(String(key))}
          >
            {activeCategory.children.map((child) => (
              <StudioMenuItem
                key={`${activeCategory.id}:${child.id}`}
                id={child.id}
                data-testid={child.testId ?? `settings-category-${activeCategory.id}-${child.id}`}
                isDisabled={child.disabled}
              >
                {child.label}
              </StudioMenuItem>
            ))}
          </StudioMenu>
        </StudioPopover>
      </MenuTrigger>
    );
  }, [
    activeCategoryId,
    activeChildCategoryId,
    categories,
    hasCategories,
    useSideNavigation,
    navTestId,
    onChildCategoryChange,
  ]);

  const mobileNavGroup = useMemo(() => {
    if (!mobileNavContent && !mobileChildNavContent) {
      return null;
    }
    return (
      <nav aria-label={`${title} ${navLabel.toLowerCase()}`} data-settings-navigation className="space-y-2" onFocusCapture={handleNavigationFocus} onBlurCapture={handleNavigationBlur}>
        {mobileNavContent}
        {mobileChildNavContent}
      </nav>
    );
  }, [handleNavigationBlur, handleNavigationFocus, mobileChildNavContent, mobileNavContent, navLabel, title]);

  return (
    <div
      ref={shellRef}
      className={[
        // One horizontal inset per breakpoint: the large-screen gutter must
        // not compete with sm:px-4 (an unprefixed px-6 always lost to it).
        "relative mx-auto w-full max-w-6xl space-y-3 px-3 py-3 sm:space-y-4",
        hasWideContainer ? "sm:px-6" : "sm:px-4",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={testId}
    >
      {showHeader ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                {showTitle ? <Heading level={3}>{title}</Heading> : null}
                {showSubtitle ? (
                  <Text
                    variant={hideTitle ? "body" : "caption"}
                    tone="muted"
                    className={[
                      showTitle ? "mt-1" : "",
                      hideTitle ? "" : "sm:truncate",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-testid="settings-shell-subtitle"
                  >
                    {subtitle}
                  </Text>
                ) : null}
              </div>
            </div>
            {showScope ? <div className="mt-2">{scope}</div> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
        </div>
      ) : null}

      {mobileNavGroup}

      {hasCategories && desktopNavContent ? (
        <div className={["grid gap-4", useSideNavigation ? "grid-cols-[12rem_minmax(0,1fr)]" : ""].join(" ")}>
          {useSideNavigation ? (
            <nav aria-label={`${title} ${navLabel.toLowerCase()}`} data-settings-navigation onFocusCapture={handleNavigationFocus} onBlurCapture={handleNavigationBlur}>
              <div className="sticky top-4" data-testid={navTestId}>
                {desktopNavContent}
              </div>
            </nav>
          ) : null}
          <div className="@container/settings-content min-w-0 space-y-4">{children}</div>
        </div>
      ) : (
        <div className="@container/settings-content min-w-0 space-y-4">{children}</div>
      )}
    </div>
  );
}
