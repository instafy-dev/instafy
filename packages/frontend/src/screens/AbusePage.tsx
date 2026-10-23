import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Heading } from "../components/Heading";
import { Text } from "../components/Text";
import { TextLink } from "../components/TextLink";
import { SOCIAL_CARD_IMAGE, applyPageMeta } from "../utils/seo";

const LAST_UPDATED = "October 23, 2026";
/** Where abuse reports go. `public/abuse.html` repeats it; a test keeps the two in step. */
export const ABUSE_CONTACT_EMAIL = "contact@instafy.dev";
const ABUSE_SUBJECT = "Abuse report";

const LINK_CLASS =
  "font-semibold underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-500 dark:decoration-slate-700";

export function AbusePage() {
  useEffect(() => {
    applyPageMeta({
      title: "Report abuse · Instafy",
      description:
        "Sites on instafy.site and other Instafy tunnel and preview addresses are made by Instafy users. Here is how to report one.",
      image: SOCIAL_CARD_IMAGE,
    });
  }, []);

  const mailto = `mailto:${ABUSE_CONTACT_EMAIL}?subject=${encodeURIComponent(ABUSE_SUBJECT)}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-slate-50 text-slate-900 dark:bg-none dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-16">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TextLink to="/" underline={false} className="w-fit">
            Back
          </TextLink>
          <Text variant="caption" tone="muted">
            Last updated: {LAST_UPDATED}
          </Text>
        </div>

        <main className="mt-10 space-y-10">
          <header className="text-left">
            <Heading level={1} variant="section" className="tracking-tight">
              Report abuse
            </Heading>
            <Text variant="lead" tone="secondary" className="mt-4 max-w-prose">
              Sites on instafy.site, and on the other addresses that Instafy tunnels and previews use, are
              made and run by Instafy users, not by Instafy. If one of them is harmful, tell us and we will
              look into it.
            </Text>
          </header>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              How to report
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Email{" "}
              <a className={LINK_CLASS} href={mailto} data-testid="abuse-contact">
                {ABUSE_CONTACT_EMAIL}
              </a>{" "}
              with the subject “{ABUSE_SUBJECT}”. For a security issue in Instafy itself, see our{" "}
              <a
                className={LINK_CLASS}
                href="https://github.com/instafy-dev/instafy/security"
                target="_blank"
                rel="noreferrer"
              >
                security policy
              </a>
              .
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              What to include
            </Heading>
            <ul className="space-y-2 pl-6 text-slate-700 dark:text-slate-200">
              {[
                "The full address of the page (for example, https://name.instafy.site/page).",
                "What is wrong with it (for example, phishing, malware, spam, or content that infringes your rights).",
                "When you saw it, and a screenshot if you have one.",
                "How we can reach you if we have questions.",
              ].map((item) => (
                <li key={item} className="list-disc">
                  <Text variant="body" tone="secondary">
                    {item}
                  </Text>
                </li>
              ))}
            </ul>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Please don’t send passwords or other people’s personal data.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              What happens next
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We read every report and aim to reply within two business days. When a site breaks our{" "}
              <Link className={LINK_CLASS} to="/terms">
                Terms of Use
              </Link>, we take it down and may suspend the account
              that runs it.
            </Text>
          </section>
        </main>
      </div>
    </div>
  );
}
