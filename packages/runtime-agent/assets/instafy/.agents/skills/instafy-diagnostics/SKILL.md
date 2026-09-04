---
name: instafy-diagnostics
description: Diagnose failed or confusing Instafy runs with the signed-in-user diagnostics CLI, explain evidence safely, and submit a customer support report only when the user explicitly asks.
---

# Instafy diagnostics

Use the typed Instafy CLI to investigate a run or runtime problem without scraping local logs,
using operator credentials, or uploading data automatically.

## Safety rules

- Use only `instafy diagnostics` for investigation and `instafy support` for customer reports.
- Never use service, operator, runtime, or raw-API credentials for this workflow.
- Read the smallest useful time range and event count. Do not collect unrelated conversations,
  projects, files, or logs.
- Treat diagnostic JSON as potentially sensitive. Summarize the relevant evidence instead of
  pasting full payloads back to the user.
- A diagnostic read never authorizes a support upload. Run `instafy support report` only when
  the user explicitly asks to file or send a report.
- Never attach logs, metadata, screenshots, or files automatically. If the user asks to include
  sensitive attachments, preview the payload and confirm the intended contents first.

## Diagnose a run

1. Identify the concrete run id from the request or active runtime context. Do not guess one.
2. Read its persisted result:

   ```bash
   instafy diagnostics run-result "<run-id>"
   ```

3. Require `schemaVersion` to be `instafy-diagnostics-v1` and `kind` to be `run-result`.
4. Require the returned `runId` to equal the requested run id. Stop and report a response-identity
   mismatch instead of analyzing another run.
5. A top-level `status` of `ready` means only that the result payload exists. Inspect the nested
   `result.status`, `result.outcome`, error, and relevant artifacts before deciding whether the
   run succeeded.
6. Explain the finding, cite the run id, and clearly separate observed facts from inference.

## Inspect runtime events

Use runtime events when the run result is missing, ambiguous, or points to runtime health or
infrastructure:

```bash
instafy diagnostics runtime-events \
  --space "<space-id>" \
  --runtime-id "<runtime-id>" \
  --since "<rfc3339-time>" \
  --limit 50
```

If the space id is unknown, omit `--space` and let the CLI use the active linked workspace. If
that resolution fails, ask the user for the space instead of guessing. Omit `--runtime-id` or
`--since` only when unavailable and necessary. Start with at most 50 events; raise the limit only
when the first bounded read proves insufficient. Require
`schemaVersion: instafy-diagnostics-v1` and `kind: runtime-events`. Event `data` is sanitized by
the controller but remains open JSON, so report only fields that support the diagnosis.

When `--space` was supplied, require the returned `spaceId` to match it. When the CLI resolved a
linked space automatically, record the returned `spaceId` and do not combine it with events from
another space. When `--runtime-id` was supplied, require every returned event's `runtimeId` to
match it; stop and report an identity mismatch rather than analyzing mixed results.

Use a runtime event as direct evidence for a run only when the returned data explicitly links the
event to that run or conversation. Otherwise describe matching runtime ids and nearby timestamps
as correlation, not proof of causation.

If the CLI exits non-zero, stdout is intentionally empty and stderr contains the safe error.
Report the failed diagnostic step; do not fall back to local process logs, a raw controller
request, or operator tooling in this workflow.

## File a support report

When the user explicitly asks to send a report, prepare a concise summary and bind only known
context:

```bash
instafy support report "<concise summary>" \
  --space "<space-id>" \
  --run-id "<run-id>" \
  --preview
```

The preview does not upload. Show the user which identifiers and attachment categories would be
sent, obtain explicit confirmation, then submit the same command once without `--preview`. Do not
retry a submission automatically.

Use `--details` for a short evidence-based explanation. Add `--metadata-file`, `--logs-file`, or
`--screenshot` only when the user selected those specific workspace-contained files. Let the CLI
perform its canonical path and regular-file checks; never bypass a traversal, symlink, or
out-of-workspace rejection. Never create an attachment by dumping the full run-result or
runtime-events response.

After submission, return the report id. The user can inspect only their own reports with:

```bash
instafy support list --json
instafy support show "<report-id>" --json
```

## Good outcome

Return a compact diagnosis containing:

- what failed or remains unknown;
- the run/runtime evidence used;
- the next safe action;
- whether a report was not sent, previewed, or submitted (with its id).

This workflow needs a signed-in human CLI session. If the controller rejects the diagnostic read,
ask the user to run `instafy login`; never substitute a scoped runtime or service credential.
