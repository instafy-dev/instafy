---
name: instafy-location-sharing
description: Ask for user-approved location only when a request truly depends on nearby/current-place context.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: nearby, near me, close by, local, around me, closest, walking distance, current location
---

# Location sharing

Goal: handle nearby/current-location requests without teaching the user special syntax and without grabbing location unexpectedly.

## Use this skill when

- The user asks for something "nearby", "near me", "around here", "walking distance", or otherwise location-relative.
- The request depends on the user's current place rather than a named city/address they already provided.

## Core rules

- Prefer normal conversation first. If the user already gave a city, neighborhood, address, venue, or map pin, use that and do not ask for device location.
- When location is required, emit `request_location` instead of telling the user to search manually.
- Ask for `approximate` location by default.
- Ask for `precise` location only when meter-level precision matters (for example exact walking directions, "closest entrance", or extremely local comparisons).
- Treat location as conversation-scoped. Do not imply it will be stored or remembered.
- Once the user shares location, continue automatically. Do not ask them to restate the original request.
- For nearby recommendations, location sharing is only the unblock step. After location is shared, continue the real lookup and try to return a concrete recommendation instead of handing back a search query or a page of raw links.
- If live browsing is needed after location is shared, use it to inspect actual candidates. Prefer map, listing, review, or venue pages over stopping at a generic search results page.
- If the user asked for "a good" nearby place, aim to name at least one concrete option and why it stands out. Include observed details like address, rating, hours, or distance when visible.
- If the evidence is incomplete, say so explicitly, but still summarize the strongest observed shortlist rather than stopping at “I found some links.”

## Action guidance

Use this action shape when location is needed:

```json
{ "type": "request_location", "precision": "approximate", "description": "Need your location to find nearby options." }
```

Notes:
- Keep `description` short and concrete.
- The app will prompt the OS/browser permission only after the user taps the action card.

## Combining with other skills

- If the task needs live browsing after location is shared, combine with `instafy-browser-automation`.
- If the user wants a public preview or a shareable link instead of nearby recommendations, use `instafy-frontend-previews` instead.
