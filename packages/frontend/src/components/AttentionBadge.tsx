const BADGE_BASE =
  "flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white dark:bg-primary-500";

/**
 * The one attention-count pill. Callers add positioning/ring classes via
 * className; the pill itself (size, radius, type, color) stays identical
 * everywhere it appears — sidebar rail, home icon, team/space switcher.
 */
export function AttentionBadge({
  count,
  max = 9,
  className,
  testId,
  title,
  "aria-hidden": ariaHidden,
}: {
  count: number;
  max?: number;
  className?: string;
  testId?: string;
  title?: string;
  "aria-hidden"?: boolean;
}) {
  if (count <= 0) {
    return null;
  }
  const label = count > max ? `${max}+` : count.toString();
  return (
    <span
      data-testid={testId}
      title={title}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : `${count} unread`}
      className={className ? `${BADGE_BASE} ${className}` : BADGE_BASE}
    >
      {label}
    </span>
  );
}
