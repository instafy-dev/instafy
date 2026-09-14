# Notifications

The controller owns a durable, account-scoped notification center. Conversation
replies, support replies and resolutions, failed runs, and automation outcomes use
one event ledger and delivery queue. Home combines conversation attention, support
updates and automation outcomes in one account-wide feed. Octo/Home is the catch-up
entry point; alert preferences live in
Your settings → Notifications. Source cursors and the event ledger are reconciled
using explicit observed snapshots, rather than clearing whatever arrived most recently.

## Storage and transaction boundaries

Quiesce and drain every old controller source writer and sender, including
in-flight direct sends, before installing the notification triggers. Apply
`20260905120000_customer_visible_bug_report_messages.sql` followed by
`20260906120000_durable_notifications.sql`, then start the updated controllers.
The notification migration is additive and replayable. It does not backfill old
messages or resolutions and does not acknowledge existing unread support activity.
Existing support activity keeps its report badge; it does not acquire a new center
entry or external delivery job merely because the migration runs.

Old binaries send conversation pushes directly after message commit. Once the
new triggers are installed, that same commit also creates a durable delivery job.
Even if the old sender stops before the first new worker starts, the queued job
can send the already-delivered activity again. Old payloads also do not honor the
new privacy or category preferences. A schema-first rolling deployment therefore
does not provide a safe cutover. A deployment that cannot quiesce old writers
needs a separately reviewed staged gating mechanism.

Source-table triggers insert the versioned event, recipients, and endpoint delivery
jobs in the same PostgreSQL transaction as the product change. An outbox insertion
failure rolls back the source mutation; delivery is never scheduled by an HTTP
handler's detached task. A producer idempotency key identifies each source message
or terminal run. Support resolutions use a per-report sequence, so reopening and
resolving again creates a new event even within one transaction.

Only `support` messages from the customer-visible `bug_report_messages` ledger
produce `support.reply`. Only `open` or `in_progress` to `resolved` transitions
produce `support.resolved`. The sole recipient is the report owner. Internal
notes, triage statuses, customer followups, and system ledger entries do not
produce customer support notifications.

For each new durable resolution, the source transaction also reserves the legacy
support-resolution alert claim. Cached clients and old claim endpoints therefore
cannot show a second toast for it. This reservation neither reads the report nor
suppresses the durable event's delivery; the support seen cursor stays independent.
Eligible resolutions from before the notification migration retain the legacy
claim fallback. Event/outbox failures roll back the reservation with the source
transition.

Human conversation messages notify the creator, explicit participants, and
selected human mentions, excluding the sender and deduplicating overlapping
recipients. Every recipient must still have current project and conversation
access. Viewing a public conversation does not itself subscribe every project
member. A mention does not grant private access or enroll someone for future
replies. Private **Invite and send** explicitly enrolls the selected teammate
before sending.

Human mentions use the composer picker's selected user IDs. The controller
accepts at most 32 UUIDs in message metadata `mentionedUserIds`, normalizes and
deduplicates them, and preserves the same source key for human-only and agent
dispatch messages. Plain text such as `@taylor` without a selected person is not
a globally resolvable username; display handles can be ambiguous.

Private-chat creation accepts `initialParticipantUserIds` and verifies each
target's existing project access before committing the conversation and its
participants together. Studio exposes the new chat only after that request
succeeds and its response confirms the intended `initialParticipantUserIds`, so
its first message cannot race a separate invitation. An older controller that
ignores the field cannot release the composer without this confirmation.
Invitations never grant project access, including in personal projects.

For automation conversations, the owner receives the terminal automation event.
Other authorized conversation participants receive visible assistant replies as
`conversation.reply`. Quiet runs and telemetry remain suppressed; automation
control failures still notify only the owner, without fanout to project members.

`notification_event_types` is the versioned registry. V1 events store an empty
payload; display text comes from static templates, not source content. To add a
category of product events, add a registry entry, its authorization rule and
transactional producer, and matching controller/client templates. Never copy
message text, logs, diagnostics, prompts, paths, secrets, or agent reasoning into
the notification ledger or external envelope.

## Delivery and retries

Each controller polls the shared outbox every five seconds. Claims use bounded
`FOR UPDATE SKIP LOCKED` leases with fresh fencing tokens, so multiple controllers
can work concurrently. The worker processes at most eight jobs concurrently,
with 90-second leases and a 60-second whole-attempt deadline. Expired leases
recover after crashes and count toward the retry budget.

Delivery is **at least once**. A provider can accept a request immediately before
a controller loses its connection. Retries keep the same `eventId`; clients use
that identity for presentation deduplication. This is not a promise of exactly
one physical OS banner under every crash or browser-storage failure.

Web Push owns presentation on subscribed browsers, including when the page is
focused; the center does not also show a toast for that channel. WebKit requires
each received push to display a notification and can revoke permission for silent
pushes ([WebKit's Web Push requirements](https://webkit.org/blog/12945/meet-web-push/)).
Repeated envelopes use the same notification tag with `renotify: false`, allowing
the browser to replace an existing notification without another alert. A retry
after the user dismisses the original can still produce another OS notification.
Native APNs foreground handling instead uses the in-app presentation path.

Transient failures retry with exponential backoff and jitter; jobs stop after
eight attempts or seven days. Attempts retain bounded internal result codes,
not provider bodies, endpoint URLs, or tokens. Expired endpoints are removed only
if they still belong to the recipient and were not re-registered after the
attempt began. Terminal failures remain in the job/attempt ledger.

Immediately before delivery, the controller rechecks current report ownership,
project and private-conversation access, category/channel preferences, unread
state, and endpoint ownership. Revoked access also hides existing center entries.
Displaying an in-app toast, reading, or archiving before a job is delivered
cancels its pending external presentation. A queued toast is acknowledged only
when it actually becomes visible; the center entry remains unread until read.

The worker's `NotificationTransport` interface accepts an account-bound, static
envelope and returns a classified delivery result. Its registered implementation
dispatches Web Push and APNs through `notifications::deliver_notification`. A future email adapter can implement the same
result contract with a separate verified-address registration flow; email is not
implemented here.

## Channels and privacy

External delivery requires both a user-enabled device registration and server
category/channel preferences. Disabling push leaves in-app notifications intact.
Preferences cover support, conversations, runs, and automations for Web Push,
APNs, and local browser/Electron presentation. Hide lock-screen previews defaults
to enabled. Opting into previews reveals only a static event description, never
the report or conversation text.

Web Push uses VAPID and RFC 8291 `aes128gcm` framing. Registration requires a valid
HTTPS endpoint on port 443 and correctly sized P-256/auth keys. Every delivery
resolves and checks all destination addresses, pins the validated addresses into
a fresh HTTP client, disables proxies and redirects, and bounds request duration.
Loopback, private, link-local, metadata, reserved, and tunnel address ranges are
rejected. Browser database roles cannot bypass registration validation by writing
endpoint tables directly.

iOS uses APNs. Android token registration is explicitly disabled until an FCM
adapter is implemented and verified. Historical Android tokens can still be
unregistered. Android's durable in-app center remains available.

Registrations and presentation state are scoped to the authenticated account.
Sign-out/account changes remove the previous account's registration and clear
local presentation state. External envelopes include `accountId`; clients reject
another account's presentation and pending navigation. Offline sign-out cannot
guarantee immediate server cleanup; generic lock-screen content and account
checks limit exposure until cleanup succeeds.

## Home and navigation

Home is the single catch-up surface on browser, mobile and Desktop. Unread updates
appear in its existing Unread lane; read updates appear in Recent activity, newest
first. Conversation replies share a row with the existing conversation summary;
support updates group by report and automation outcomes by automation identity.
The Octo badge counts unread destinations using the same grouping. Unknown and
account-wide support updates appear under All, not an inferred organization.
Older unread support reports remain visible even when they predate the ledger.

Home's Mark all read applies only to the currently loaded, filtered unread rows,
using their exact notification IDs. It does not mark new arrivals or other teams
read. Legacy support rows without a safe notification snapshot clear by opening
the report; they are excluded from Mark all read. Older pages retain their loaded
boundary as new activity arrives. Failed loads remain retryable and are not
presented as an empty account. There is no
separate notification bell or notification dialog. Existing external alerts and
toasts continue to use the controller-owned event ledger and preferences.

The profile picture opens an account popover on desktop and a compact sheet on
narrow screens. Both offer Your settings, Support and Sign out. Support unread
badges stay in Home rather than also appearing on the profile picture. Device
alert permission and channel controls live together under Your settings →
Notifications; the account menu does not toggle device permissions. Profile,
Preferences and Notifications remain visible as category tabs on narrow screens.
Appearance choices (System, Light and Dark) live under Preferences.

The server owns monotonic seen/read/archive timestamps; a stale device cannot
unread or unarchive a notification. Existing API read-all/archive operations
remain compatible. Toasts are transient presentation, not durable state.

`POST /me/notifications/inbox/ack-snapshot` acknowledges at most 100 explicitly
supplied notification IDs for the authenticated account and conversation. The
`expectedUserId` must match that account. An optional `expectedLastMessageId`
advances the legacy inbox cursor only when that exact observed message is still
latest; a concurrent reply leaves it unread and returns `inboxAcknowledged: false`.
The original `/inbox/ack` remains available to older clients. New clients use the
separate snapshot route so older servers reject it without silently acknowledging
newer activity. Mutation callers pin their account and access token across async
work and reject a substituted controller credential.

Reading a normal conversation acknowledges only persisted message IDs actually
visible in the chat viewport while the document and chat pane are visible.
Offscreen messages and messages covered by a dialog are not acknowledged. The
account-pinned `POST /me/notifications/conversation-read` endpoint accepts a
`conversationId`, at most 100 `messageIds`, and `expectedUserId`; it rechecks
current access and marks only that user's matching `conversation.reply` events
seen and read. It does not use a server-latest timestamp: concurrent arrivals,
including backdated messages, stay unread until displayed. This cancels their
pending external delivery only after those specific messages are read; support
cursors remain independent.

Canonical targets contain UUIDs only. Support targets use
`/studio?supportReportId=<report-id>`; conversations use
`/studio?projectId=<project-id>&conversationControllerId=<conversation-id>`.
Service-worker, native push action, browser, and Electron clicks route through
validated navigation. Clicks append `notificationEventId` and
`notificationAccountId` UUIDs to the resource target. Authentication preserves
these IDs without fetching report metadata while logged out. The destination
opens and acknowledges the notification only for the matching signed-in account;
successful acknowledgement removes the receipt from the URL and refreshes the
Home feed. Delivery alone never marks an event read. Explicitly reading a durable
support update advances its source cursor only when that update is still the
report's current support activity. Reading a conversation notification similarly
advances its source inbox only when its exact source message is current; unrelated
and newer updates remain unread.

Report detail acknowledges exact loaded support message IDs and the observed
`resolutionNotificationId` returned with that detail snapshot. It does not use a
timestamp range to mark durable events read, so concurrent or backdated replies
remain unread. The existing customer support cursor still records the displayed
report timeline. These additions require no database migration.

## Configuration and operational verification

Controller configuration:

- Web Push: `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and
  `WEB_PUSH_VAPID_SUBJECT`.
- APNs: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, and
  `APNS_PRIVATE_KEY` or `APNS_PRIVATE_KEY_B64`. `APNS_USE_SANDBOX` selects the
  default environment for new registrations without an explicit environment.
  Stored production/sandbox registrations retain their selected environment.
- FCM: unsupported; no Android delivery configuration is consumed.

Keep credentials in the deployment secret store. Inspect only whether required
keys are present on the running controller; never print secret values. Presence
alone does not prove valid credentials, entitlements, bundle identity, network
egress, or successful delivery. This repository and automated test results do
not establish deployed VAPID/APNs configuration.

Before a production rollout, verify:

1. The two migrations are installed and the running controller has the required
   VAPID/APNs keys, reporting presence only.
2. A real browser/PWA receives an encrypted push while closed, opens the exact
   report, and synchronizes read state with a second device.
3. A provisioned physical iPhone receives sandbox/production APNs as appropriate,
   resumes the report from a cold start, and respects preview preferences.
4. Packaged Electron notification clicks focus the window and open the target.
5. Sign-out, switching accounts, revoking membership, re-registering a token,
   disabled categories, and OS notification denial behave as expected.
6. A provider outage retries without losing the event, and a controller restart
   recovers leased jobs without creating a second event.

## Automated verification

Run `python3 scripts/test-durable-notifications.py --controller-test notification`
for the disposable PostgreSQL simulation and the notification controller tests.
The script creates and cleans up its own database; without `--controller-test`
it runs only the SQL simulation on a private Unix socket. Tests never require production
provider credentials. Transport contracts use HTTP mocks and the published
RFC 8291 encryption vector; these are not physical-device or live-provider tests.

The PostgreSQL simulation checks source rollback, producer idempotency,
concurrent leases, authorization revocation, preference isolation, monotonic
reads, crash/retry recovery, migration replay, and the support reply → resolution
→ reopen → second resolution flow. The HTTP lifecycle test separately exercises
center pagination, account isolation, read state, preference persistence, safe
deep links, and support-cursor independence through the real controller router.

See [Testing](Testing.md) for package-level TypeScript, ESLint, frontend, Rust,
and migration checks. Invoke installed package binaries directly in environments
where a package-manager hook is unsafe.

Recorded outcomes and remaining verification boundaries are in
[Notification implementation verification](Notification-Verification.md).
