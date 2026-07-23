import { Badge } from "../../../components/Badge";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { truncate } from "./chatContentHelpers";
import type { TemplateToolCallInfo } from "./chatMessageDetailHelpers";

export function TemplateToolCallDetails({ info }: { info: TemplateToolCallInfo }) {
  const { selection, alternatives, total } = info;
  if (!selection && alternatives.length === 0) {
    return null;
  }

  const otherCount = Math.max(total - (selection ? 1 : 0), alternatives.length);

  return (
    <div className="mt-3 space-y-3">
      {selection ? (
        <Surface tone="muted" radius="xl" shadow="none" className="px-4 py-3 shadow-inner">
          <Text variant="overline" tone="subtle" className="tracking-[0.18em]">
            Selected template
          </Text>
          <Text variant="bodyStrong" tone="primary" className="mt-2">
            {selection.label}
          </Text>
          {selection.description ? (
            <Text variant="body" tone="inherit" className="mt-1 text-slate-600 dark:text-slate-300">
              {selection.description}
            </Text>
          ) : null}
          {selection.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {selection.tags.map((tag) => (
                <Badge key={tag} size="xs" className="bg-white text-slate-500 dark:bg-slate-950 dark:text-slate-300">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            {selection.creditCost !== null ? (
              <Text as="span" variant="caption" tone="muted">
                Credit cost: {selection.creditCost}
              </Text>
            ) : null}
            {selection.source ? (
              <Text as="span" variant="caption" tone="muted">
                Source: {selection.source}
              </Text>
            ) : null}
          </div>
        </Surface>
      ) : null}
      {alternatives.length > 0 ? (
        <Surface tone="default" radius="xl" shadow="none" className="px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <Text variant="overline" tone="subtle" className="tracking-[0.18em]">
              Other matches
            </Text>
            <Text as="span" variant="overline" tone="subtle">
              {otherCount} shown
            </Text>
          </div>
          <ul className="mt-3 space-y-2">
            {alternatives.slice(0, 3).map((option) => (
              <li
                key={option.id}
                className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40"
              >
                <Text variant="bodyStrong" tone="secondary">
                  {option.label}
                </Text>
                {option.description ? (
                  <Text
                    variant="caption"
                    tone="inherit"
                    className="mt-1 leading-relaxed text-slate-600 dark:text-slate-300"
                  >
                    {truncate(option.description, 160)}
                  </Text>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xxs text-slate-500">
                  {option.tags.slice(0, 4).map((tag) => (
                    <Badge
                      key={tag}
                      size="xs"
                      className="border-transparent bg-white text-slate-500 dark:bg-slate-950 dark:text-slate-300"
                    >
                      {tag}
                    </Badge>
                  ))}
                  {option.creditCost !== null ? (
                    <Text as="span" variant="caption" tone="muted" className="text-xxs">
                      Credits: {option.creditCost}
                    </Text>
                  ) : null}
                  {option.source ? (
                    <Text as="span" variant="caption" tone="muted" className="truncate text-xxs">
                      {option.source}
                    </Text>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Surface>
      ) : null}
    </div>
  );
}
