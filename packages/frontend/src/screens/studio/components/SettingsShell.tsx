import { useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { NavArrowDown } from "iconoir-react";
import { MenuTrigger } from "react-aria-components";
import { Card } from "../../../components/Card";
import { EntityRow } from "../../../components/EntityRow";
import { Heading } from "../../../components/Heading";
import { Text } from "../../../components/Text";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";
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
  onCategoryChange?: (categoryId: string) => void;
  activeChildCategoryId?: string | null;
  onChildCategoryChange?: (categoryId: string) => void;
  children: ReactNode;
  className?: string;
  navLabel?: string;
  testId?: string;
  navTestId?: string;
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
}: SettingsShellProps) {
  const isLargeScreen = useStudioDesktopLayout();
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

  const desktopNavContent = useMemo(() => {
    if (!hasCategories || !categories) {
      return null;
    }
    return (
      <div className="space-y-2.5">
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
                <Card
                  tone="muted"
                  radius="xl"
                  shadow="none"
                  padding="sm"
                  className="ml-3 space-y-1 p-1.5 dark:border-slate-800/90 dark:bg-slate-900/60"
                >
                  {category.children.map((child) => (
                    <EntityRow
                      key={`${category.id}:${child.id}`}
                      onPress={() => onChildCategoryChange(child.id)}
                      title={child.label}
                      pressable
                      isDisabled={child.disabled}
                      data-testid={child.testId ?? `settings-category-${category.id}-${child.id}`}
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
                </Card>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }, [activeCategoryId, activeChildCategoryId, categories, hasCategories, onCategoryChange, onChildCategoryChange]);

  const mobileNavContent = useMemo(() => {
    if (!hasCategories || !categories || isLargeScreen) {
      return null;
    }
    const activeCategory = categories.find((category) => category.id === activeCategoryId) ?? categories[0] ?? null;
    if (!activeCategory) {
      return null;
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
          end={<NavArrowDown className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
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
    isLargeScreen,
    navLabel,
    navTestId,
    onCategoryChange,
  ]);

  const mobileChildNavContent = useMemo(() => {
    if (!hasCategories || !categories || isLargeScreen || !activeCategoryId || !onChildCategoryChange) {
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
          end={<NavArrowDown className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
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
    isLargeScreen,
    navTestId,
    onChildCategoryChange,
  ]);

  const mobileNavGroup = useMemo(() => {
    if (!mobileNavContent && !mobileChildNavContent) {
      return null;
    }
    return (
      <Card
        tone="subtle"
        radius="2xl"
        shadow="none"
        padding="sm"
        className="space-y-2 p-2 dark:border-slate-800/90 dark:bg-slate-950/85"
      >
        {mobileNavContent}
        {mobileChildNavContent}
      </Card>
    );
  }, [mobileChildNavContent, mobileNavContent]);

  return (
    <div
      className={[
        // One horizontal inset per breakpoint: the large-screen gutter must
        // not compete with sm:px-4 (an unprefixed px-6 always lost to it).
        "relative mx-auto w-full max-w-6xl space-y-3 px-3 py-3 sm:space-y-4",
        isLargeScreen ? "sm:px-6" : "sm:px-4",
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
        <div className={["grid gap-4", isLargeScreen ? "grid-cols-[14rem_minmax(0,1fr)]" : ""].join(" ")}>
          {isLargeScreen ? (
            <div className="block">
              <Card
                tone="subtle"
                radius="2xl"
                shadow="none"
                padding="sm"
                className="sticky top-4 border-slate-200/70 bg-white/95 backdrop-blur-sm dark:border-slate-800/90 dark:bg-slate-950/85"
              >
                <Text as="p" variant="overline" tone="muted" className="px-1">
                  {navLabel}
                </Text>
                <div className="mt-2" data-testid={navTestId}>
                  {desktopNavContent}
                </div>
              </Card>
            </div>
          ) : null}
          <div className="min-w-0 space-y-4">{children}</div>
        </div>
      ) : (
        <div className="min-w-0 space-y-4">{children}</div>
      )}
    </div>
  );
}
