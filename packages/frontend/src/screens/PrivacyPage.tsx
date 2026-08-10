import { useEffect } from "react";
import { Heading } from "../components/Heading";
import { Text } from "../components/Text";
import { TextLink } from "../components/TextLink";
import { applyPageMeta } from "../utils/seo";

const LAST_UPDATED = "March 23, 2026";
const CONTACT_EMAIL = "contact@instafy.dev";

export function PrivacyPage() {
  useEffect(() => {
    applyPageMeta({
      title: "Privacy Policy · Instafy",
      description:
        "Learn how Instafy collects, uses, and shares information when you use our chat-first AI space.",
      image: "/og-image.png",
    });
  }, []);

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
              Privacy Policy
            </Heading>
            <Text variant="lead" tone="secondary" className="mt-4 max-w-prose">
              This Privacy Policy explains how Instafy (“we”, “us”) collects, uses, and shares information
              when you use Instafy (the “Service”).
            </Text>
          </header>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              1. Information we collect
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We collect information in the following categories:
            </Text>
            <ul className="space-y-2 pl-6 text-slate-700 dark:text-slate-200">
              {[
                "Account information (for example, email address, authentication provider, and basic profile details).",
                "Workspace and project content (for example, file names/paths, edits, prompts, messages, and artifacts you choose to store in the Service).",
                "Usage and device information (for example, IP address, browser type, device identifiers, logs, and operational telemetry needed to operate and secure the Service).",
                "Release and update telemetry for our desktop/mobile apps (for example, app version, release channel, platform, architecture, device identifiers, and update/download success or failure events reported by the client).",
                "Coarse location information derived from IP or trusted edge-delivery metadata (for example, country code) when needed for operational analytics such as release health, delivery reliability, and fraud/abuse detection.",
                "Billing information (for example, subscription status and Stripe customer/checkout identifiers; payment card details are handled by our payment processor).",
              ].map((item) => (
                <li key={item} className="list-disc">
                  <Text variant="body" tone="secondary">
                    {item}
                  </Text>
                </li>
              ))}
            </ul>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Where your workspace data lives can vary based on how you use the Service. For example, you
              may connect a local folder or a self-hosted runtime, or you may use an Instafy-hosted workspace.
              We access and process workspace data only as needed to provide the Service.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              2. Cookies and local storage
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We use cookies and local storage to keep you signed in, remember preferences, and support
              basic product functionality (for example, remembering accounts on the login screen). You can
              clear cookies/local storage through your browser settings, but this may affect the Service.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              3. How we use information
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We use information to:
            </Text>
            <ul className="space-y-2 pl-6 text-slate-700 dark:text-slate-200">
              {[
                "Provide, maintain, and secure the Service (including authentication, workspace access, and run orchestration).",
                "Process prompts and content to generate AI-assisted outputs and apply requested file changes.",
                "Operate credits, subscriptions, and billing.",
                "Respond to support requests and communicate with you about the Service.",
                "Monitor release health, update rollout safety, download/install reliability, and coarse country-level delivery patterns for our desktop and mobile apps.",
                "Improve and debug the Service using aggregated or de-identified analytics where feasible.",
              ].map((item) => (
                <li key={item} className="list-disc">
                  <Text variant="body" tone="secondary">
                    {item}
                  </Text>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              4. How we share information
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We may share information with:
            </Text>
            <ul className="space-y-2 pl-6 text-slate-700 dark:text-slate-200">
              {[
                "Service providers that help us operate the Service (for example, Supabase for authentication and data storage, and Cloudflare for content delivery, access control, and operational analytics).",
                "Payment processors (for example, Stripe) to process subscriptions and payments.",
                "AI model providers and runtime providers you use to generate responses or run tasks (your prompts and related context may be sent to these providers to fulfill your request).",
                "Law enforcement or regulators when required by law, or to protect rights, safety, and security.",
              ].map((item) => (
                <li key={item} className="list-disc">
                  <Text variant="body" tone="secondary">
                    {item}
                  </Text>
                </li>
              ))}
            </ul>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              If you join an organization within the Service, organization administrators may be able to view
              certain account and workspace information associated with that organization.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              5. Google OAuth and Google user data
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              If you choose Google OAuth to connect Gemini, we request the Google scopes you approve
              during sign-in. Depending on the configured Gemini mode, this can include profile/email scopes
              and cloud-platform access scopes needed for the requested Gemini flow.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We use Google user data only to authenticate your account connection, securely store and refresh
              your OAuth credential, and call Google/Gemini APIs to fulfill actions you request in the Service.
              We do not sell Google user data or use it for advertising.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Our use and transfer of information received from Google APIs adheres to the{" "}
              <a
                className="font-semibold underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-500 dark:decoration-slate-700"
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noreferrer"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              You can revoke access at any time by removing the Gemini connection in Instafy settings,
              revoking app access in your Google account permissions at{" "}
              <a
                className="font-semibold underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-500 dark:decoration-slate-700"
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noreferrer"
              >
                myaccount.google.com/permissions
              </a>
              , or contacting us at{" "}
              <a
                className="font-semibold underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-500 dark:decoration-slate-700"
                href={`mailto:${CONTACT_EMAIL}`}
              >
                {CONTACT_EMAIL}
              </a>
              .
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              6. Data retention
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We retain information for as long as needed to provide the Service, comply with legal
              obligations, resolve disputes, and enforce agreements. Retention may vary depending on the
              type of data and how you use the Service (for example, whether your workspace is local-canonical
              or hosted).
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              7. Security
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We use reasonable administrative, technical, and organizational safeguards designed to protect
              information. No method of transmission or storage is 100% secure.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              8. Your choices and rights
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Depending on where you live, you may have rights to access, correct, delete, or object to
              certain processing of your information. To make a request, email{" "}
              <a
                className="font-semibold underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-500 dark:decoration-slate-700"
                href={`mailto:${CONTACT_EMAIL}`}
              >
                {CONTACT_EMAIL}
              </a>
              .
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              9. Children’s privacy
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              The Service is not directed to children, and we do not knowingly collect personal information
              from children under 13 (or other age as required by local law).
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              10. Changes to this policy
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We may update this Privacy Policy from time to time. We’ll update the “Last updated” date
              above and may provide additional notice in the Service for material changes.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              11. Contact
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Questions about privacy? Email{" "}
              <a
                className="font-semibold underline decoration-slate-300 underline-offset-4 transition hover:decoration-slate-500 dark:decoration-slate-700"
                href={`mailto:${CONTACT_EMAIL}`}
              >
                {CONTACT_EMAIL}
              </a>
              .
            </Text>
          </section>
        </main>
      </div>
    </div>
  );
}
