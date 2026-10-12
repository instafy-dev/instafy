import { Heading } from "../../components/Heading";

// Each card says something the hero, the example window and the integration
// row above it have not: where a space starts, where it runs, and that its
// files keep a history.
const FEATURES = [
  {
    title: "Start where you are",
    description: "Import a GitHub repo, or start from an empty space.",
  },
  {
    title: "Our machine or yours",
    description: "Run a space on a hosted machine, or on your own computer with the desktop app.",
  },
  {
    title: "Real files you can rewind",
    description: "Every change is saved as a version you can review and revert.",
  },
];

export function LandingFeatures() {
  return (
    <section aria-labelledby="landing-features-title" className="border-t border-slate-200 py-14 dark:border-white/10 sm:py-20">
      <Heading id="landing-features-title" level={2} variant="section" className="max-w-xl tracking-tight">
        Hand it to an agent.<br />Decide what stays.
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
