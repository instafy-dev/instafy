import type { ReactNode } from "react";

export function MarketingGridSection(props: {
  children: ReactNode;
  className?: string;
  fade?: boolean;
}) {
  const fade = props.fade ?? true;

  return (
    <section className={["relative w-full", props.className].filter(Boolean).join(" ")}>
      <div
        aria-hidden="true"
        className={[
          "pointer-events-none absolute inset-0 z-0",
          "bg-[linear-gradient(to_right,rgba(15,23,42,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.06)_1px,transparent_1px)]",
          "bg-[size:40px_40px] opacity-70",
          fade ? "[mask-image:linear-gradient(to_bottom,transparent_0px,black_260px,black_100%)]" : "",
          "dark:bg-[linear-gradient(to_right,rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.08)_1px,transparent_1px)]",
          "dark:opacity-25",
        ]
          .filter(Boolean)
          .join(" ")}
      />

      <div className="relative z-10">{props.children}</div>
    </section>
  );
}

