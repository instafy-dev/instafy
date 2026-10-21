# Follow mode

One member presents a site preview ([Previews.md](Previews.md)); the others in the space follow it live. Each viewer
still renders their own copy of the site in their own pane. Follow mode shares only **what is visible**, as the site
describes it (a map's area, the open tab, a list's sort and scroll), plus a ripple where the presenter taps. It works
for any site that speaks the small message protocol below; a site that does not is simply not offered **Present**.

```
 presenter's site --view/tap--> Studio (≤ 10 views/s, location guard) --POST follow--> controller FollowHub
                                                                                         | watch: latest view only
                                                                                         | broadcast(16): taps
                                                                                         | Redis <ns>:controller:follow
 follower's site <--apply-view/apply-tap-- Studio <--SSE follow/stream------------------+
 everyone in the space <-- /events kind "preview.follow" (presence only: live, away, ended, follower count)
```

Nothing is stored. A view lives in memory as the latest view of a live presentation and is never logged (logs carry
size and seq only). There are no tables and no migrations. Viewers' positions are never shared: a follower sends
nothing, and a presenter's view that holds their own location is not sent (see the location guard below).

## Controller API (`packages/runtime-controller/src/previews/follow.rs`)

Every route is off (503 `previews_unavailable`) wherever previews are off, and uses the gate of
`GET /projects/:projectId/previews/:previewId` (membership and private-runtime visibility); a caller who fails it gets
**404** on all three routes. Only a signed-in person may use them: runtime and job tokens get 403, no token gets 401.
Names and avatars come from `profiles` or the account metadata, never from the client. Any POST body over 8 KiB gets
413 before anything else is checked.

```
POST /projects/:projectId/previews/:previewId/follow
  {op:"present"}                              → 200 {presentationId, presenter:{id,name,avatarUrl?}, startedAt, replaced?:{id,name}}
                                                 the last one wins; 429 {code:"too_many_presentations"} past 3 per user;
                                                 429 + Retry-After past 3 presents within 3 s per person and preview
  {op:"view", presentationId, seq?, payload?} → 202; payload is opaque JSON ≤ 2,048 bytes (413 above); no payload = heartbeat.
                                                 a seq at or below the last one is accepted and ignored
  {op:"tap",  presentationId, seq, payload}   → 202; payload {x,y} in 0..1 of the frame plus an optional site-defined `at`; else 400
  {op:"stop", presentationId}                 → 200 {stopped: bool}; safe to repeat
  errors: 409 {state:"replaced", presenter} · 409 {state:"ended", presenter:null} (it ended, or the preview stopped)
          409 {state:"unknown", presenter:null}: this node never heard of it (its Present may still be on the way)
          403 a view or tap from someone other than the presenter · 429 + Retry-After (views 20/s, burst 40; taps 5/s)

GET  /projects/:projectId/previews/:previewId/follow
  → 200 {presentation: null | {presentationId, presenter, startedAt, state:"live"|"away", seq, payload, replaced?},
         followers:[{id,name,avatarUrl?}]}           // the presenter is never listed as a follower

GET  /projects/:projectId/previews/:previewId/follow/stream   (SSE; opening it means "I am following")
  event: state {presentation, followers}             // on connect, presenter change, follower join/leave
  event: view  {seq, payload, at}  id: seq           // latest only; always sent on (re)connect
  event: tap   {seq, payload, at}                    // not replayed
  event: end   {reason:"stopped"|"replaced"|"timeout"|"closed"|"access", presentationId?}
  keep-alive every 15 s. `end{replaced}` goes only to the replaced presenter's own streams; followers follow the
  preview and get a `state` whose presentation carries `replaced:{id,name}`.

/events, kind "preview.follow" (presence only, never views):
  data {previewId, presentationId, state:"live"|"away"|"ended", presenter:{id,name}, followers:n, runtimeId?, reason?}
  It carries the preview's conversation id and runtime id, so private-conversation and private-runtime visibility
  apply as for any event.
```

**Limits and timers.** Two follow streams per user under their own `follow:user:<id>` key, so they never take an
`/events` slot (not counted in dev mode, as for `/events`). A presenter who sends nothing for 15 s turns **away**;
120 s later the presentation **ends** (`timeout`); 4 h is the cap. Access is checked again every
`event_access_recheck_after` (5 s); a member who loses access gets `end{access}` and the stream closes. A preview that
is closed, stopped with its machine or expired ends its presentation (`end{closed}`: at once on close, otherwise at a
follower's next access check or the presenter's next view) and cannot be presented. Presenting and following are not
activity in the space: they never keep the space's machine running. (Studio does keep the presenter's and followers'
own screens from dimming while the page is visible; see `usePreviewFollow.ts`.) Rate buckets and the stream limit
count per node; the 3-presentation cap counts every node.

**Who may present.** Anyone who may see the preview may present it, viewers included, and may take over someone
else's presentation: the last one wins. Presenting only shares what a site shows; it changes nothing in the space and
costs nothing. A takeover is never silent: the button reads **Present instead** (with "Kim's followers will follow
you"), followers read "Lena took over from Kim", and Kim's own chip says Lena presents now.

**Between nodes.** With `REDIS_URL` set, presentations, views, taps and stops travel on `<ns>:controller:follow` with
their own queue; a burst of views is thinned to the latest before publishing. Every node keeps every presentation and
works out presence itself, so each node announces `preview.follow` to its own streams only. With two presents at once,
the later start time wins everywhere. Without Redis the hub is in-process.

A view or tap load-balanced to a node that has not heard the Present yet gets 409 `unknown`, not `ended`: Studio sends
it again after 250 ms and 1 s, and only then treats the presentation as ended. Each heartbeat announces the
presentation again, so a node that missed the Present (Redis was unreachable, which drops messages) learns it within
one heartbeat. A node remembers presentations that ended on it for 10 minutes, so a late view reads `ended` and a late
repeat of the Present never brings an ended presentation back. Both buses (events and follow) use one channel
mechanism in `redis_bus.rs`, each with its own connection and queue.

## Studio (`packages/frontend/src/screens/studio/components/previewHost/`)

- `services/runtimeController/previewFollow.ts`: the relay client. The stream is read with `fetch` (it needs the
  `Authorization` header), reconnects with backoff, and stops for good on 404/403/410. The stop on `pagehide` uses
  `fetch(…, {keepalive:true})`.
- `followMode.ts`: the pane's state and every label; the pacing (≤ 10 views/s, latest wins, a trailing send, waits out
  a 429); payload checks (plain JSON ≤ 2 KB; taps inside the frame); the **location guard**: a view or tap holding the
  latitude **and** longitude of a position the frame was given since it last loaded fresh is not sent, and the
  presenter sees "📍 Your location is left out". It is best effort against a site leaking the position by accident:
  it catches decimals within 1e-3 degrees (about 110 m, so copies rounded to 3 or more places, in numbers or in text)
  and whole micro- or 1e-7 degrees. A map centred that close to the person is held back too, since it shows where
  they are. Rounding to 2 places or an encoding of its own gets through, so the skill's "never put the person's own
  position in it" is the main control. The guard has no time limit, because the page may still hold the position in
  its URL or state. Studio gives a frame no position today (the frame may not use geolocation), so the guard has
  nothing to match until something does.
- `usePreviewFollow.ts`: Present and Stop, a heartbeat every 5 s while the page is visible, followers fetched every
  15 s and whenever the count changes, taps capped at 5/s, a screen wake lock (the person's own screen, never the
  space's machine) while presenting or following and the page is visible. Following
  stops on the site's `interact` (ignored for 300 ms after an applied view) or when focus moves into the frame;
  Studio's own controls never stop it.
- `followStore.ts`: who presents each preview, from `preview.follow` and GET follow; late events are ignored. A
  presentation belongs to the page, not to the pane: opening a run tab or another conversation unmounts the pane but
  does not end the presentation. Without the pane's heartbeats the presenter reads as away; a pane for that preview that
  mounts again presents again at once, carrying on from the seq the page last sent (the relay ignores a seq at or
  below the last one, so starting again from 0 would freeze followers). Closing the preview's tab, Stop, or leaving the
  page ends it.
- Endings say why: a presenter whose page was in the background for more than about 135 s (a call screen, a locked
  phone) reads "Kim went away, so following stopped". Followers follow Kim again on their own if she presents again
  within 5 minutes ("Kim is back: following again"). Kim, back on the page, reads "Your presentation ended while you
  were away".
- Your own presentation from another screen is never offered to you as Follow: the chip reads "You're presenting on
  another screen · Stop" and Present says "Present from here".
- `useSiteHost.ts` plugs this into `SitePreviewPane`: the pane keeps the frame, the viewer session and the frame and
  origin checks, and hands the frame's other messages over. `FollowControls.tsx` draws the chip and **Present** in the
  pane's browser bar (the same bar on desktop and phone), the ring around a followed frame and the tap ripples.
  `SitePreviewCard` says who presents and offers **Follow <name>**, which opens the pane already following.

## Studio ↔ site messages (v1)

The frame's address carries `?instafy_host=studio`, so a site knows a host frames it. Studio checks that every message
comes from its own frame at the viewer's origin, and reads them as data, never as commands.

```
Studio → site  {source:"instafy-host", v:1, type:"layout", insets, chrome:"host", title:"shown", caps:{geolocation:false}, theme}
site → Studio  {source:<the site's own short name>, v:1, type:"layout-ack", payload:{supports:["view", "tap"?]}}
site → Studio  {…, type:"view", seq, payload}                 // ≤ 2 KB, opaque; only sent on while Studio says it presents
site → Studio  {…, type:"tap", seq, payload:{x, y, at?}}       // x,y in 0..1 of the frame
site → Studio  {…, type:"interact"}                            // the person's own gesture (not an applied view)
Studio → site  {source:"instafy-host", v:1, type:"present", on, share:{location:false}}
Studio → site  {source:"instafy-host", v:1, type:"apply-view", seq, payload, from:{id,name}, smooth}
Studio → site  {source:"instafy-host", v:1, type:"apply-tap", payload, from:{id,name}}   // only if the ack listed "tap"
```

- Studio sends `present` and `apply-view` only to a frame whose ack listed `"view"`, and offers **Present** only for
  one. Within one page load the supported list only grows; a new page load starts empty.
- `smooth:false` is for the first view after (re)connecting, a late join and **Follow again**.
- **The relay does not check a payload's shape, so sites must.** A view comes from another member, and a member can
  send any JSON of the right size straight to the relay, without the site. Studio hands it to followers' frames as it
  came. A site reads only the keys it expects, of the types it expects; applying a view only changes what is shown
  (never a write, a purchase, a message, a URL fetched or opened from it, or a value put into HTML or code); it shows
  `from.name` as text; it reads host messages only from `window.parent` and answers to that message's origin, never
  `"*"`; and it puts only shared, non-secret state in a view (no tokens, nothing only that person may see). The
  frontend-previews skill tells Octo all of this.
- A site that supports `"tap"` draws the presenter's tap itself; otherwise Studio draws it at `x,y` with the
  presenter's name for 1.2 s.

## Tests

- Controller: `pnpm test:controller previews::follow_tests` (the 404 gate, fan-out, 413, 429, takeover, away, timeout
  and the 4 h cap on a paused clock, two hubs on an in-memory bus, access revoked, close, a stopped preview, no rows
  written, a viewer taking over, presents rate-limited, a view reaching a node before its Present). With
  `FOLLOW_TEST_REDIS_URL=redis://127.0.0.1:6379`, two follow hubs and two event buses also meet through a real Redis.
- Frontend: `followMode.test.ts`, `SitePreviewFollow.test.tsx`, `SitePreviewCardFollow.test.tsx`,
  `previewFollow.test.ts`, `previewHostMessages.test.ts`; e2e `project-preview-ready.spec.ts` "follow mode" (a desktop
  presenter and a 390 px phone follower on a real preview, through the real relay).
