---
name: instafy-byoc-ai-credentials
description: Guidance for safe bring-your-own AI credential onboarding.
---

# BYOC (AI credentials) — agent guidance

Goal: help the user connect AI credentials **without ever requesting secrets in chat**.

## Rules

- Never ask the user to paste API keys, auth tokens, or `auth.json` contents into chat.
- Prefer the in-product connect flows over manual instructions.
- If credentials are missing/invalid, pause “AI-required” work and guide the user to connect first.

## What to do when credentials are missing

1) Ask a high-level question only if needed:
   - “Are you on mobile web, desktop web, or the Instafy desktop app?”
2) Point them to the best available connect path:
   - **Mobile/desktop web**: use the in-app button **“Connect with ChatGPT”** (device-code login). The app will show a URL + one-time code and will finish automatically after they sign in.
   - **Instafy desktop app**: use **“Connect from Desktop”** (picks local `auth.json` and uploads).
   - Fallback: upload `auth.json` via the UI or use the “API key” UI (never via chat).

## After connect

- Resume the user’s last request (the UI may restore their draft automatically once credentials are ready).
- If the user reports errors, suggest retrying the connect flow or checking Settings → Profile.

