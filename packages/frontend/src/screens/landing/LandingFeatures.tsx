import { Heading } from "../../components/Heading";

const FEATURES = [
  {
    title: "A place for the whole crew",
    description:
      "People and agents share the same conversation, files, and preview. Invite a teammate and pick up the work together.",
  },
  {
    title: "Your tools. Your choice.",
    description:
      "Connect the AI you already use and bring your own repository. Open the studio in your browser, or take it to your desktop.",
  },
  {
    title: "Real files, a clear history",
    description:
      "Work lives in files you control. Inspect the changes, keep what works, and return to an earlier version when you need to.",
  },
];

export function LandingFeatures() {
  return (
    <section aria-labelledby="landing-features-title" className="border-t border-slate-200 py-14 dark:border-white/10 sm:py-20">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">A little more in sync</p>
      <Heading id="landing-features-title" level={2} variant="section" className="mt-3 max-w-xl tracking-tight">
        One conversation.<br />More hands on the work.
      </Heading>
      <div className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
        {FEATURES.map((feature, index) => (
          <div key={feature.title}>
            <span aria-hidden="true" className="font-mono text-xs text-primary-600 dark:text-primary-400">
              0{index + 1}
            </span>
            <Heading level={3} variant="subtitle" className="mt-3 font-semibold">
              {feature.title}
            </Heading>
            <p className="mt-3 max-w-sm text-sm leading-7 text-slate-600 dark:text-slate-400">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
