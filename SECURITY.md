# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use this repository's **Security** tab to open a private vulnerability report or draft a
private security advisory for the maintainers. Include:

- the affected component and version or commit;
- the impact and prerequisites;
- minimal reproduction steps or a proof of concept;
- whether credentials, user data or shared infrastructure may be affected; and
- a safe way to contact you for follow-up.

Do not include live credentials, personal data or data copied from another user's workspace.
Use inert fixtures and redact logs before attaching them.

We will acknowledge a complete report, investigate it privately and coordinate remediation
and disclosure based on severity. Please allow the maintainers a reasonable opportunity to
fix the issue before publishing details.

## Supported versions

Until stable releases are published, security fixes target the current `main` branch. After
versioned releases begin, this section will list the supported release lines.

## Security boundaries

Instafy accepts reports about the public source and its default self-hosted configuration.
Reports about a third-party provider, model service, browser, operating system or extension
should also be sent to that vendor when the issue is outside Instafy's control.

Never use security testing to access data or systems you do not own or have explicit
permission to test.
