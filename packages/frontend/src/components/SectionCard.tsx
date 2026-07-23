import type { PropsWithChildren } from "react";
import { Heading } from "./Heading";
import { Text } from "./Text";

type SectionCardProps = PropsWithChildren<{
  title: string;
  description?: string;
  className?: string;
}>;

export function SectionCard({ title, description, children, className }: SectionCardProps) {
  return (
    <section
      className={`rounded-3xl border border-mist/70 bg-white/95 p-6 shadow-sm shadow-mist/40 backdrop-blur ${
        className ?? ""
      }`}
    >
      <header className="mb-4">
        <Heading level={2} variant="title">
          {title}
        </Heading>
        {description ? (
          <Text variant="body" tone="secondary" className="mt-1">
            {description}
          </Text>
        ) : null}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
