import {
  useMemo,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  describeKnownLinkHost,
  labelAlreadyNamesHost,
  readLinkHost,
} from "./chatLinkHosts";
import { createMarkdownHeadingSlug } from "./markdownOutline";

type MarkdownPreviewProps = {
  value: string;
  className?: string;
};

type MarkdownElementProps<T> = HTMLAttributes<T> & { node?: unknown };
type MarkdownAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };
type MarkdownCodeProps = HTMLAttributes<HTMLElement> & { inline?: boolean; node?: unknown };
type MarkdownTableProps = TableHTMLAttributes<HTMLTableElement> & { node?: unknown };
type MarkdownThProps = ThHTMLAttributes<HTMLTableCellElement> & { node?: unknown };
type MarkdownTdProps = TdHTMLAttributes<HTMLTableCellElement> & { node?: unknown };

function flattenMarkdownHeadingText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (!children || typeof children === "boolean") {
    return "";
  }
  if (Array.isArray(children)) {
    return children.map((child) => flattenMarkdownHeadingText(child)).join("");
  }
  if (typeof children === "object" && "props" in children) {
    const node = children as { props?: { children?: ReactNode } };
    return flattenMarkdownHeadingText(node.props?.children ?? null);
  }
  return "";
}

export function MarkdownPreview({ value, className }: MarkdownPreviewProps) {
  const components = useMemo(() => {
    const headingSlugCounts = new Map<string, number>();
    const createHeadingComponent =
      (
        tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6",
        classNames: string
      ) =>
      ({ node, children, className, ...props }: MarkdownElementProps<HTMLHeadingElement>) => {
        void node;
        const headingText = flattenMarkdownHeadingText(children).trim();
        const baseSlug = createMarkdownHeadingSlug(headingText);
        const count = headingSlugCounts.get(baseSlug) ?? 0;
        headingSlugCounts.set(baseSlug, count + 1);
        const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
        const Tag = tag;

        return (
          <Tag
            {...props}
            id={slug}
            data-markdown-heading-slug={slug}
            className={`${classNames} ${className ?? ""}`}
          >
            {children}
          </Tag>
        );
      };

    return {
      h1: createHeadingComponent("h1", "text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50"),
      h2: createHeadingComponent("h2", "mt-8 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50"),
      h3: createHeadingComponent("h3", "mt-6 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50"),
      h4: createHeadingComponent("h4", "mt-6 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50"),
      h5: createHeadingComponent("h5", "mt-5 text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50"),
      h6: createHeadingComponent("h6", "mt-5 text-sm font-semibold uppercase tracking-[0.14em] text-slate-700 dark:text-slate-300"),
      p: ({ node, children, className, ...props }: MarkdownElementProps<HTMLParagraphElement>) => {
        void node;
        return (
          <p {...props} className={`leading-7 text-slate-700 dark:text-slate-200 ${className ?? ""}`}>
            {children}
          </p>
        );
      },
      a: ({ node, children, className, ...props }: MarkdownAnchorProps) => {
        void node;
        // This renders workspace files, and a workspace holds SKILL.md files
        // imported from whatever repository the person pointed at. So the text
        // here is untrusted in the most direct way available: not a model's
        // paraphrase of a pack, the pack itself. A markdown link shows only its
        // label, so it is gated exactly as the chat renderer is. An approved
        // host wears its mark, anything else is written out beside the label,
        // and an address that is not http or https is not pressable at all.
        const host = typeof props.href === "string" ? readLinkHost(props.href) : null;
        if (!host) {
          return <span className={className}>{children}</span>;
        }
        const known = describeKnownLinkHost(props.href as string);
        const KnownMark = known?.mark;
        const label = typeof children === "string" ? children : "";
        const showHost = !known && !labelAlreadyNamesHost(label, host);
        return (
          <a
            {...props}
            target={props.target ?? "_blank"}
            rel={props.rel ?? "noreferrer"}
            title={props.href}
            data-link-host={host}
            data-link-known={known ? "true" : "false"}
            className={`font-medium text-primary-600 hover:underline dark:text-primary-400 ${className ?? ""}`}
          >
            {KnownMark ? (
              <KnownMark
                className="mr-1 inline h-[0.92em] w-[0.92em] flex-none align-[-0.08em]"
                aria-hidden
              />
            ) : null}
            {children}
            {showHost ? <span className="ml-1 font-normal opacity-80">({host})</span> : null}
          </a>
        );
      },
      ul: ({ node, children, className, ...props }: MarkdownElementProps<HTMLUListElement>) => {
        void node;
        return (
          <ul
            {...props}
            className={`list-disc space-y-2 pl-6 text-slate-700 dark:text-slate-200 ${className ?? ""}`}
          >
            {children}
          </ul>
        );
      },
      ol: ({ node, children, className, ...props }: MarkdownElementProps<HTMLOListElement>) => {
        void node;
        return (
          <ol
            {...props}
            className={`list-decimal space-y-2 pl-6 text-slate-700 dark:text-slate-200 ${className ?? ""}`}
          >
            {children}
          </ol>
        );
      },
      li: ({ node, children, className, ...props }: MarkdownElementProps<HTMLLIElement>) => {
        void node;
        return (
          <li {...props} className={`leading-7 ${className ?? ""}`}>
            {children}
          </li>
        );
      },
      blockquote: ({ node, children, className, ...props }: MarkdownElementProps<HTMLQuoteElement>) => {
        void node;
        return (
          <blockquote
            {...props}
            className={`border-l-4 border-slate-200 pl-4 text-slate-600 dark:border-slate-800 dark:text-slate-300 ${className ?? ""}`}
          >
            {children}
          </blockquote>
        );
      },
      hr: ({ node, className, ...props }: MarkdownElementProps<HTMLHRElement>) => {
        void node;
        return (
          <hr {...props} className={`my-8 border-slate-200 dark:border-slate-800 ${className ?? ""}`} />
        );
      },
      pre: ({ node, children, className, ...props }: MarkdownElementProps<HTMLPreElement>) => {
        void node;
        return (
          <pre
            {...props}
            className={`overflow-x-auto rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-900 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-100 ${className ?? ""}`}
          >
            {children}
          </pre>
        );
      },
      code: ({ node, inline, className: innerClassName, children, ...props }: MarkdownCodeProps) => {
        void node;
        if (inline) {
          return (
            <code
              {...props}
              className={`rounded-md border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-100 ${innerClassName ?? ""}`}
            >
              {children}
            </code>
          );
        }

        return (
          <code {...props} className={`font-mono ${innerClassName ?? ""}`}>
            {children}
          </code>
        );
      },
      table: ({ node, children, className, ...props }: MarkdownTableProps) => {
        void node;
        return (
          <div className="overflow-x-auto">
            <table
              {...props}
              className={`w-full border-collapse text-left text-sm text-slate-700 dark:text-slate-200 ${className ?? ""}`}
            >
              {children}
            </table>
          </div>
        );
      },
      thead: ({ node, children, className, ...props }: MarkdownElementProps<HTMLTableSectionElement>) => {
        void node;
        return (
          <thead {...props} className={`border-b border-slate-200 dark:border-slate-800 ${className ?? ""}`}>
            {children}
          </thead>
        );
      },
      tbody: ({ node, children, className, ...props }: MarkdownElementProps<HTMLTableSectionElement>) => {
        void node;
        return (
          <tbody {...props} className={`divide-y divide-slate-100 dark:divide-slate-900 ${className ?? ""}`}>
            {children}
          </tbody>
        );
      },
      th: ({ node, children, className, ...props }: MarkdownThProps) => {
        void node;
        return (
          <th
            {...props}
            className={`whitespace-nowrap px-3 py-2 font-semibold text-slate-900 dark:text-slate-50 ${className ?? ""}`}
          >
            {children}
          </th>
        );
      },
      td: ({ node, children, className, ...props }: MarkdownTdProps) => {
        void node;
        return (
          <td {...props} className={`px-3 py-2 align-top ${className ?? ""}`}>
            {children}
          </td>
        );
      },
    };
  }, []);

  return (
    <div className={["space-y-4", className].filter(Boolean).join(" ")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {value}
      </ReactMarkdown>
    </div>
  );
}
