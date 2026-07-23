import { useEffect } from "react";
import { Heading } from "../components/Heading";
import { Text } from "../components/Text";
import { TextLink } from "../components/TextLink";
import { applyPageMeta } from "../utils/seo";

const LAST_UPDATED = "January 10, 2026";
const CONTACT_EMAIL = "contact@instafy.dev";

export function TermsPage() {
  useEffect(() => {
    applyPageMeta({
      title: "Terms of Use · Instafy Studio",
      description:
        "These Terms of Use govern access to Instafy Studio, a chat-first AI space for editing real files.",
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
              Terms of Use
            </Heading>
            <Text variant="lead" tone="secondary" className="mt-4 max-w-prose">
              These Terms of Use (“Terms”) govern your access to and use of Instafy Studio (the “Service”).
              By accessing or using the Service, you agree to these Terms.
            </Text>
          </header>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              1. The Service
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Instafy Studio is a chat-first AI space that helps you create, edit, and manage spaces with real
              files. The Service includes an assistant surface, a file explorer and editor, and a credits and
              billing surface.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              The Service may be offered in preview/beta. Features may change, be removed, or behave
              differently across environments (for example, when connected to a local folder vs a hosted
              workspace).
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              2. Accounts and access
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              You may need an account to use some features. You are responsible for maintaining the
              confidentiality of your login credentials and for all activity under your account.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              3. Your content and spaces
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              “Content” includes space files, prompts, messages, inputs, outputs, assets, and other material
              you upload, create, or submit through the Service.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Depending on your setup, spaces may be hosted by Instafy or processed in an environment you
              control (for example, a local folder or self-hosted runtime). You’re responsible for configuring
              and using the Service in a way that fits your needs and compliance requirements.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              You retain ownership of your Content. You grant Instafy a limited license to host, process,
              transmit, and display your Content as necessary to provide and secure the Service (for example,
              to apply edits to your workspace, run tasks you request, and return results to you).
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              You are responsible for your Content, including ensuring you have the rights to use it and that
              it doesn’t violate applicable laws or third-party rights.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              4. AI features and outputs
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              The Service may use third-party AI model providers and/or providers you configure to generate
              suggestions and outputs (“AI Outputs”). AI Outputs can be incorrect or incomplete and may
              include code that requires careful review and testing. You are responsible for verifying AI
              Outputs before using them, especially in production systems.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Do not submit sensitive information you do not want processed by the Service or shared with
              providers (for example, secrets, private keys, or confidential customer data) unless you
              understand and accept the associated risks.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              5. Credits, billing, and payments
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Some features may require credits or a paid subscription. Credits and plan limits may be scoped
              to an organization. If you purchase a subscription, you authorize us and our payment processor
              to charge applicable fees and taxes.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Payment processing is handled by third parties (for example, Stripe). We don’t store your full
              payment card details. Refunds, if any, are handled according to the checkout terms or as
              required by law.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Subscriptions renew monthly and can be canceled at any time; cancellation takes effect at the
              end of the current billing period, and you keep your plan’s features until then. We do not
              offer refunds for partial billing periods except where the law requires them.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Right of withdrawal (EU/Austrian consumers): the Service is digital content and paid features
              are made available to you immediately after purchase. By purchasing, you expressly consent to
              immediate performance of the contract and acknowledge that you thereby lose your 14-day right
              of withdrawal under the Austrian Distance Selling Act (FAGG) once performance has begun
              (§ 18 (1) FAGG and Art. 16(m) Directive 2011/83/EU).
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              6. Acceptable use
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              You agree not to misuse the Service. For example, you will not:
            </Text>
            <ul className="space-y-2 pl-6 text-slate-700 dark:text-slate-200">
              {[
                "Use the Service for illegal activities, including generating or distributing unlawful content.",
                "Interfere with or disrupt the Service, including attempting to bypass usage limits or security controls.",
                "Upload malware or attempt to gain unauthorized access to systems or data.",
                "Use the Service to violate the privacy or rights of others.",
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
              7. Third-party services
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              The Service may integrate with third-party services (for example, GitHub for sign-in, hosted
              runtimes/providers, AI model providers, Supabase for authentication/storage, and Stripe for
              payments). Your use of third-party services is subject to their terms and policies, and we are not
              responsible for third-party services.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              8. Suspension and termination
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We may suspend or terminate access to the Service if we reasonably believe you’ve violated
              these Terms or if we need to protect the Service, other users, or third parties. You may stop
              using the Service at any time.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              9. Disclaimers and limitation of liability
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              The Service is provided “as is” and “as available.” To the fullest extent permitted by law, Instafy
              disclaims all warranties, express or implied, including warranties of merchantability, fitness for a
              particular purpose, and non-infringement.
            </Text>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              To the fullest extent permitted by law, Instafy will not be liable for indirect, incidental, special,
              consequential, or punitive damages, or any loss of data, profits, or revenue, arising from or
              related to your use of the Service.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              10. Changes to these Terms
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              We may update these Terms from time to time. If we make material changes, we’ll update the
              “Last updated” date above and may provide additional notice in the Service.
            </Text>
          </section>

          <section className="space-y-4">
            <Heading level={2} variant="title" className="tracking-tight">
              11. Contact
            </Heading>
            <Text variant="bodyLg" tone="secondary" className="max-w-prose">
              Questions about these Terms? Email{" "}
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
