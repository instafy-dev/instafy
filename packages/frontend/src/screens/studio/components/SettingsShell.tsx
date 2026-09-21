import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type FocusEvent, type ReactNode } from "react";
import { Button as AriaButton, DialogTrigger } from "react-aria-components";
import { ControlChevron } from "../../../components/ControlChevron";
import { Button } from "../../../components/Button";
import {
  segmentedControlGroupClassName,
  segmentedControlOptionClassName,
  SEGMENTED_CONTROL_LABEL_CLASS,
} from "../../../components/segmentedControlStyles";
import { pickerListRowTextClassName } from "../../../components/listRowStyles";
import { EntityRow } from "../../../components/EntityRow";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import { SettingsNavigationLabelContext } from "../../../components/SettingsNavigationLabelContext";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";

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
  onCategoryChange?: (categoryId: string, childCategoryId?: string) => void;
  activeChildCategoryId?: string | null;
  onChildCategoryChange?: (categoryId: string) => void;
  children: ReactNode;
  className?: string;
  navLabel?: string;
  testId?: string;
  navTestId?: string;
  /** A small, flat category set can remain visible when a sidebar won't fit. */
  compactCategoryNavigation?: "auto" | "picker" | "tabs";
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
  compactCategoryNavigation = "auto",
}: SettingsShellProps) {
  const isLargeScreen = useStudioDesktopLayout();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [hasWideContainer, setHasWideContainer] = useState(false);
  const navigationFocusRef = useRef<HTMLElement | null>(null);
  const wideContainerRef = useRef(false);
  const useSideNavigation = isLargeScreen && hasWideContainer;
  const useCompactTabs = compactCategoryNavigation !== "picker" && Boolean(categories?.length && categories.length <= 3 && categories.every(category => !category.children?.length));

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
  const activeCategory = categories?.find(category => category.id === activeCategoryId) ?? categories?.[0];
  const activeChild = activeCategory?.children?.find(child => child.id === activeChildCategoryId)
    ?? activeCategory?.children?.[0];
  const repeatedHeading = hasCategories && !useSideNavigation && !useCompactTabs
    ? activeChild?.label ?? activeCategory?.label ?? null
    : null;
  const content = (
    <SettingsNavigationLabelContext.Provider value={repeatedHeading}>
      <div className="@container/settings-content min-w-0 space-y-4">{children}</div>
    </SettingsNavigationLabelContext.Provider>
  );
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
      mobileCategoryTriggerRef.current?.focus();
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
                  "min-h-10 pointer-coarse:min-h-11",
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
                      className="min-h-9 pointer-coarse:min-h-11"
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
        <div className={`flex min-w-0 ${segmentedControlGroupClassName()}`} data-testid={`${navTestId}-tabs`}>
          {categories.map(category => {
            const active = category.id === activeCategoryId;
            return (
              <AriaButton
                key={category.id}
                type="button"
                isDisabled={category.disabled}
                onPress={() => onCategoryChange?.(category.id)}
                aria-current={active ? "page" : undefined}
                data-testid={category.testId ?? `settings-category-${category.id}`}
                className={[
                  segmentedControlOptionClassName(active),
                  "min-h-11 flex-auto whitespace-nowrap text-sm",
                ].join(" ")}
              >
                <span className={SEGMENTED_CONTROL_LABEL_CLASS}>
                  {category.label}
                </span>
              </AriaButton>
            );
          })}
        </div>
      );
    }
    return (
      <SettingsCategoryPicker
        categories={categories}
        activeCategoryId={activeCategoryId}
        activeChildCategoryId={activeChildCategoryId}
        onCategoryChange={onCategoryChange}
        onChildCategoryChange={onChildCategoryChange}
        navLabel={navLabel}
        navTestId={navTestId}
        triggerRef={mobileCategoryTriggerRef}
      />
    );
  }, [
    activeCategoryId,
    activeChildCategoryId,
    categories,
    hasCategories,
    useSideNavigation,
    useCompactTabs,
    navLabel,
    navTestId,
    onCategoryChange,
    onChildCategoryChange,
  ]);

  const mobileNavGroup = useMemo(() => {
    if (!mobileNavContent) {
      return null;
    }
    return (
      <nav aria-label={`${title} ${navLabel.toLowerCase()}`} data-settings-navigation className="space-y-2" onFocusCapture={handleNavigationFocus} onBlurCapture={handleNavigationBlur}>
        {mobileNavContent}
      </nav>
    );
  }, [handleNavigationBlur, handleNavigationFocus, mobileNavContent, navLabel, title]);

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
          {content}
        </div>
      ) : (
        content
      )}
    </div>
  );
}


/** Browse nested categories in one anchored surface; only destinations change the route. */
function SettingsCategoryPicker({
  categories,
  activeCategoryId,
  activeChildCategoryId,
  onCategoryChange,
  onChildCategoryChange,
  navLabel,
  navTestId,
  triggerRef,
}: Pick<SettingsShellProps, "activeCategoryId" | "activeChildCategoryId" | "onCategoryChange" | "onChildCategoryChange"> & {
  categories: SettingsCategory[];
  navLabel: string;
  navTestId: string;
  triggerRef: { current: HTMLButtonElement | null };
}) {
  const [open, setOpen] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const previouslyOpenRef = useRef(false);
  const returnParentFocusIdRef = useRef<string | null>(null);
  const activeCategory = categories.find(category => category.id === activeCategoryId) ?? categories[0];
  const activeChild = activeCategory?.children?.find(child => child.id === activeChildCategoryId)
    ?? activeCategory?.children?.[0];
  const parent = categories.find(category => category.id === parentId && category.children?.length);
  const items = parent?.children ?? categories;
  const selectedId = parent
    ? parent.id === activeCategoryId ? activeChild?.id : undefined
    : activeCategoryId;
  const goBack = () => {
    if (parent) {
      returnParentFocusIdRef.current = parent.id;
      setParentId(null);
    } else setOpen(false);
  };
  useNativeBackButtonAction(open, goBack, 240);

  useEffect(() => {
    const wasOpen = previouslyOpenRef.current;
    previouslyOpenRef.current = open;
    if (!open) {
      if (!wasOpen) return;
      const frame = requestAnimationFrame(() => {
        if (document.activeElement === document.body && triggerRef.current?.isConnected) triggerRef.current.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    // Replacing a menu level unmounts its focus scope. Complete that handoff
    // after the old scope restores focus, once the new collection is mounted.
    const frame = requestAnimationFrame(() => {
      const pane = paneRef.current;
      if (!pane) return;
      const returnParent = parentId === null && returnParentFocusIdRef.current
        ? [...pane.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')]
          .find(item => item.dataset.key === returnParentFocusIdRef.current)
        : null;
      returnParentFocusIdRef.current = null;
      const selected = pane.querySelector<HTMLElement>('[role^="menuitem"][data-selected]:not([aria-disabled="true"])');
      const first = pane.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
      (returnParent ?? selected ?? first ?? pane.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, parentId, triggerRef]);

  const onOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      returnParentFocusIdRef.current = null;
      setParentId(activeCategory?.children?.length ? activeCategory.id : null);
    }
    setOpen(nextOpen);
  };
  const select = (itemId: string) => {
    const item = items.find(candidate => candidate.id === itemId);
    if (!item || item.disabled || parent?.disabled) return;
    if (!parent && item.children?.length) {
      setParentId(item.id);
      return;
    }
    setOpen(false);
    if (parent) {
      if (parent.id === activeCategoryId && onChildCategoryChange) onChildCategoryChange(item.id);
      else onCategoryChange?.(parent.id, item.id);
    } else onCategoryChange?.(item.id);
  };
  if (!activeCategory) return null;
  const activeLabel = activeChild ? `${activeCategory.label} / ${activeChild.label}` : activeCategory.label;
  return (
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <EntityRow
        ref={triggerRef}
        title={activeChild ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-normal text-slate-500 dark:text-slate-400">{activeCategory.label}</span>
            <span aria-hidden="true" className="font-normal text-slate-400">/</span>
            <span className="truncate">{activeChild.label}</span>
          </span>
        ) : activeCategory.label}
        start={activeCategory.icon ? <activeCategory.icon className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden={true} /> : null}
        end={<ControlChevron />}
        pressable
        isDisabled={categories.every(category => category.disabled)}
        data-testid={`${navTestId}-picker`}
        surface="outlined"
        density="compact"
        className="min-h-11"
        aria-label={`${navLabel}: ${activeLabel}`}
      />
      <StudioDialogPopover triggerRef={triggerRef} placement="bottom start" offset={6}
        className="min-w-[var(--trigger-width)] max-w-[calc(100vw-1.5rem)] p-2"
        data-testid={`${navTestId}-popover`}>
        <div ref={paneRef} onKeyDownCapture={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            goBack();
          }
        }}>
          {parent ? (
            <Button variant="ghost" size="sm" radius="lg" onPress={goBack}
              aria-label={`Back to ${navLabel.toLowerCase()}`} data-testid={`${navTestId}-back`}
              className="mb-1 min-h-11 w-full justify-start !gap-2 !px-2.5">
              <ControlChevron direction="left" /><span>Back</span>
            </Button>
          ) : null}
          <Heading slot="title" level={4} className="px-2.5 pb-2 pt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {parent?.label ?? navLabel}
          </Heading>
          <StudioMenu key={parent?.id ?? "root"} aria-label={parent ? `${parent.label} sections` : navLabel}
            autoFocus selectionMode="single" selectedKeys={selectedId ? [selectedId] : []}
            onAction={key => select(String(key))}
            // Parent rows browse this surface; destination selection and Escape own dismissal.
            onClose={() => undefined} className="space-y-1">
            {items.map(item => {
              const Icon = item.icon;
              return (
                <StudioMenuItem key={item.id} id={item.id} textValue={item.label}
                  data-testid={item.testId ?? `settings-category-${parent ? `${parent.id}-` : ""}${item.id}`}
                  isDisabled={item.disabled || parent?.disabled}
                  className={`min-h-11 ${item.danger ? "text-rose-600 dark:text-rose-400" : ""}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden={true} /> : null}
                    <span className="truncate">{item.label}</span>
                  </span>
                  {!parent && item.children?.length ? <ControlChevron direction="right" /> : null}
                </StudioMenuItem>
              );
            })}
          </StudioMenu>
        </div>
      </StudioDialogPopover>
    </DialogTrigger>
  );
}
