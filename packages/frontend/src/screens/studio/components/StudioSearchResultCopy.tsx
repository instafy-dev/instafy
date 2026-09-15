import type { ReactNode } from "react";
import "./StudioSearchResultCopy.css";

export interface StudioSearchMessageExcerpt {
  excerpt: string;
  query: string;
  /** UTF-16 offsets into the plain-text excerpt, as returned by the controller. */
  matchRanges: readonly { start: number; end: number }[];
  authorLabel: string;
  createdAt: string;
}

export function highlightStudioSearchExcerpt(
  text: string,
  ranges: StudioSearchMessageExcerpt["matchRanges"],
): ReactNode[] {
  const valid = ranges.filter(({ start, end }) => Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && end > start && end <= text.length)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of valid) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const output: ReactNode[] = [];
  let offset = 0;
  for (const { start, end } of merged) {
    if (start > offset) output.push(text.slice(offset, start));
    output.push(<mark key={`${start}:${end}`}>{text.slice(start, end)}</mark>);
    offset = end;
  }
  if (offset < text.length) output.push(text.slice(offset));
  return output;
}

export function StudioSearchResultCopy({ title, description, message }: {
  title: string;
  description: string;
  message?: StudioSearchMessageExcerpt;
}) {
  const timestamp = message ? new Date(message.createdAt) : null;
  const date = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null;
  return <span className="studio-search-result-copy">
    <strong>{title}</strong>
    <span>{description}</span>
    {message ? <>
      <span className="studio-search-message-meta">
        {message.authorLabel}
        {date ? <> · <time dateTime={message.createdAt}>{date.toLocaleString(undefined, {
          month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
        })}</time></> : null}
      </span>
      <span className="studio-search-message-excerpt">
        {highlightStudioSearchExcerpt(message.excerpt, message.matchRanges)}
      </span>
    </> : null}
  </span>;
}
