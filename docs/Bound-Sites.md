# Bound sites

> **Status.** Package `packages/instafy-bind` (zero dependencies, Node 18+, no build), CLI `instafy-bind` and
> `instafy bind` (the binder is bundled into the CLI's `dist/bind`), skill `instafy-bound-sites`, page starters and
> example sites (`hello`, `shoes`, `follow-table`). Outside the package: the origin server keeps `.bind/` private
> (§4), the controller names Studio's origin when a preview opens (§4, Frames) and checks where an ask came from
> (§2a), the runtime seeds the skill and shows Octo an ask's site intent (§2a), and Studio is the page's host frame.
>
> **In Studio.** Studio's preview pane frames the page with `?instafy_host=studio` and sends `layout` (theme,
> `caps.location: "host"`, `caps.ask`). Location and follow mode work there (§2b, docs/Previews.md,
> docs/Follow-Mode.md), and so does Ask Octo (§2a): a click is the clicker's own chat message. Outside Studio (a
> phone tab, a public tunnel, a plain browser) asks stay hidden; script intents work everywhere.

A **bound site** is an ordinary website plus a small generic backend, the **binder**. Clicks in the site become
typed **intents**. The binder runs script intents through a deterministic handler; an "Ask Octo" intent is handed to
Studio and sent as the clicker's own chat message. Results come back as typed **records** with provenance. The binder writes them into the
site's data files and streams them to every open viewer. Octo can also push **commands** back into the site (select,
highlight, toast, reload). That is the two-way bind:

```
  Site (any website)           Binder (generic; `instafy-bind serve`)                Executors
  bind client  --intent-->     POST /__bind/intent   validate vs bound.json  ---->  script: node handler (NDJSON)
               <--events---    GET  /__bind/events   SSE to every viewer
               <--command--    POST /__bind/command  (admin token only)
                               apply: validate records, merge, version bump
                               data/records/<intent>.json, data/version.json
  bind client  --ask------->   Studio (the page's host frame) --> a normal chat message from the clicker
```

Octo generates bound sites the same way it generates any site. It writes the page and a `bound.json` and starts
`instafy-bind serve` (plus a tunnel). The binder is generic, so Octo never writes backend code. The only per-site
"backend" is `bound.json` plus optional handler scripts.

## Quick start

```bash
# from the repo root; no install needed for the binder itself
node packages/instafy-bind/bin/instafy-bind.mjs serve packages/instafy-bind/examples/hello
#   -> hello: http://127.0.0.1:4180/#k=<viewer token>   open it twice, click "Ask the binder" in one

node packages/instafy-bind/bin/instafy-bind.mjs command packages/instafy-bind/examples/hello toast '{"text":"Hi from chat"}'

# the shoes compare grid: a script intent (read_offer) and an "Ask Octo" agent intent (check_size)
node packages/instafy-bind/bin/instafy-bind.mjs serve packages/instafy-bind/examples/shoes --dry-run
#   An Ask Octo click is an ask for Studio (§2a). --dry-run prints, for clicks on this machine, the prompt the owner's
#   executor would send. --agent-executor (with `instafy login` and --space <id>) is the owner's opt-in to run them
#   as Octo turns on their own login, for their own clicks on this machine only (§3).

# a new site
node packages/instafy-bind/bin/instafy-bind.mjs init my-site && node packages/instafy-bind/bin/instafy-bind.mjs doctor my-site

# the same through the Instafy CLI (after `corepack pnpm --filter @instafy/cli run build`)
node packages/instafy-cli/bin/instafy.js bind serve packages/instafy-bind/examples/hello

# tests
cd packages/instafy-bind && npm test     # core + example handlers (node --test)
```

## The idea, generalised

A bound site is not a special kind of app. It is any static site plus one generic process. The site declares what it
can ask for (`bound.json`: intent names, param schemas, which executor runs each one). The page asks with
`instafyBind.intent(name, params)`. The binder validates, runs the executor, validates what comes back, writes it into
the site's own data files and pushes it to every open page. So:

- **"Backend"** is the binder, and it is the same for every site. A site's own code is the page, `bound.json`, and
  optionally a few handler scripts that print NDJSON.
- **The binding to Instafy** is Studio. An "Ask Octo" click is handed to the page's host frame, which sends it as
  the clicker's own chat message, billed like typing it (§2a). Octo talks back to open pages with
  `instafy bind command <site> <name> '<json>'`, using the admin token on disk. Neither the page nor the binder holds
  an Instafy credential.
- **Data is the contract.** Records (`instafy.records@1`: claims, offers, items, each with source, lane, observed time and
  TTL) are the only thing an executor can change. That is what makes a script and an Octo turn interchangeable, and
  what keeps an agent's answer from rewriting the page.
- **How Octo generates one.** The `instafy-bound-sites` skill: write the page against `__bind/client.js`, write
  `bound.json`, add handlers for anything deterministic, `doctor`, `try` each script intent once (it runs the handler
  exactly as a click would and fails on a crash, an error or only rejected records), `serve`, share the printed URL
  (tunnel with consent). A failed click shows as a toast when the page does not handle `error` events itself. Octo never writes server code, so the security properties (tokens, SSRF checks, schema validation,
  cooldowns) come with every site.
- **Later transports, same protocol.** The client already accepts `postMessage` from a parent frame (`instafy-host`,
  only from the origins the binder lists: `bound.json` `parentOrigins`, and in a preview the Studio that opened it),
  so a Studio pane can replace the local binder's SSE without the page changing.

## 1. Parts

| Part | What | Where |
|---|---|---|
| Site | Any static site (HTML/JS, a compare grid, a tracker). Loads the bind client; the binder adds it to plain pages | the site folder |
| `bound.json` | Manifest: intents, param schemas, executor per intent, prompt templates, output targets | site root |
| Bind client | `__bind/client.js`, a tiny browser library: `bind.intent(name, params)`, `bind.on(type, fn)`, records store, transports | served by the binder |
| Binder | Static server + intent endpoint + SSE + apply step + jobs + tokens | `packages/instafy-bind` |
| Executors | `script` (handler process, NDJSON); `agent` only with the owner's `--agent-executor` (§3) | `packages/instafy-bind/src/executors/` |
| Skill | Teaches Octo to generate bound sites | `packages/runtime-agent/assets/instafy/.agents/skills/instafy-bound-sites/` |

## 2. Protocol

Every endpoint is under `__bind/`, relative to the site (a gallery's site at `/<name>/` has `/<name>/__bind/`).

- **Intent out** (site → binder): `{ source, v: 2, type: "intent", id: "int_<base36 time>_<4 rand>", name, params, ui?, ref?, site?, state?, at }`.
  - `source` is `instafy-site`. `by` from the page is ignored; the binder stamps its own observer.
  - `ref` must look like `<collection>:<id>` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[A-Za-z0-9_.:-]{1,120}$`), and `ui` and
    `attr` are short tokens. They reach logs, prompts and other viewers, so free text is refused (400).
- **Host → site**: `{ source: "instafy-host", v: 2, type: hello|ack|progress|results|done|error|command, id?, job?, status?, progress?, records?, files?, error?, user?, capabilities?, command? }`.
- **Endpoints**:
  - `GET health` → `{ok, host: "instafy-bind", v: 2, intents: [...], catalog, asks: [...], token, viewer,
    parentOrigins}` (`asks`: the agent intents a click on this request hands to Studio, each `via: "host"`;
    `parentOrigins`: who may host this page in a frame, see §4 Frames);
  - `POST intent` → `202 {status:"queued"|"needs_confirm", id, job, cancel_key}` | `400` | `401` | `403` | `404` |
    `409` (a coalesced job, or `ask_via_host` for an agent intent: §2a) | `429` (`cooldown`, `rate`, `busy`, `budget`). `cancel_key` goes only to the submitting viewer; the
    `cancel` intent needs it;
  - `GET events` → SSE, all viewers get all events (one event per intent id, also for coalesced jobs),
    `Last-Event-ID` replay from a ring buffer. It also takes the token as `?k=`, because EventSource cannot send a
    header and a page framed by another site may not get its cookie;
  - `GET jobs`, `GET records` (viewer token);
  - `POST session` (trades the header token for the HttpOnly site cookie);
  - `POST command`, `POST confirm` (admin token);
  - `GET client.js`.
- **Limits and extras**: the intent body may be 8 KB (params stay ≤ 4 KB); SSE also carries `hello` and `command`,
  and every host message carries `name` (and `ref`); error codes are `not_found`, `timeout`, `policy`, `upstream`,
  `unavailable`, `invalid`, `cancelled`, `dry_run`, `internal`; records files say `writer.cmd: "instafy-bind"`.
- **Records**: `instafy.records@1` (`src/records-schema.mjs`): `claim`, `offer` and `item`, each with a `prov` that
  includes `source`, `lane`, `observed_at` and `ttl_s`. A newer observation replaces an older one of the same id;
  assist and capture records never replace another lane's.
- **Files**: `data/records/<intent>.json` (or `target.records`), and `data/version.json` (`{v, updated_at, files, jobs}`)
  so polling-only viewers also update.

## 2a. Ask Octo (host-mediated)

An agent intent (`"executor": "agent"`) is an **ask**. It never reaches the binder as work:

1. The binder lists it in `health.asks` and the SSE `hello` (`capabilities.asks`), never in `intents`, and answers a
   `POST intent` for it with `409 {status:"rejected", reason:"ask_via_host"}`. It reads no Instafy login for it.
2. The bind client offers asks only when the page's host frame takes them: a frame at one of the origins the binder
   lists (§4 Frames) whose layout message says `caps.ask: true`. Then the ask is in `names` like any intent
   (`via: "host"`), and a click posts, only to the host's origin:
   `{source:"instafy-bind", v:1, type:"ask", payload:{id, intent, label, params, ref, say?, confirm?, withheld?, coarsened?}}`
   (`say` and `confirm` are the intent's own, from `bound.json`, §3).
   The message is read by everyone in the conversation, so the client rounds a position to about 100 m (3 decimals)
   and drops accuracy, altitude, heading and speed (`coarsened` names those params), and leaves out the intent's
   `private_params` (`withheld` names them). The host must not add them back: it sends `params` as given.
3. The host sends it as a normal chat message from the person who clicked, in the conversation the preview belongs
   to, billed exactly like that person typing it. Whoever may send messages there may ask. For anyone else the host
   says `caps.ask: "<plain reason>"`: the client lists the asks with `disabled: "<reason>"` and a click sends nothing.
4. The host answers `{source:"instafy-host", v:1, type:"ask-status", payload:{id, state, reason?}}` with `state`
   `sent`, `done`, `declined` or `failed`, or `confirm` while it asks the person first; the client turns these into
   the usual `ack` (`sent`, `needs_confirm`), `done` and `error` events. With no answer in 5 s the click is cleared
   with "Instafy did not answer" (a click waiting on `confirm` is not).
5. Outside a host that takes asks (a phone tab, a public tunnel, a plain browser) asks are not in `names`, so a page
   that draws buttons from `names` hides them. Public and anonymous viewers never trigger an owner-paid turn.

The host treats every page message as a request, never a decision: the label and params come from the page, so the
message it sends must be its own rendering, and repeated ids are dropped.

**Studio, the host** (`packages/frontend/src/screens/studio/components/previewHost/`: `hostMessages.ts`,
`siteAsks.ts`, `useSiteAsks.ts`; the conversation side in `ChatPanel.tsx`):
- **Who may ask.** `caps.ask` comes from the access the composer uses: `true` for someone who may send messages in
  the conversation the preview pane is shown in; otherwise one plain sentence (a view-only member reads "You can view
  this space but not send messages in it, so you can't ask Octo here." on the site's disabled Ask Octo button).
- **What it takes.** An `ask` only from the pane's own frame window at the viewer capability's origin, only while the
  pane is on screen, with a well-formed payload (id, intent name, label ≤ 120, params ≤ 2 KB of plain JSON, ref in
  the protocol's shape). A malformed one is declined by its id. A repeated id is dropped.
- **Caps.** One ask at a time per person and site (until its run ends), and six in ten minutes, in each Studio tab;
  the controller also refuses a seventh in ten minutes per person and preview. A cap answers `declined` with the
  reason ("Octo is still answering your last question from this site. Try again when it's done.").
- **The message.** Studio renders it: the intent's `say` template filled from the params (a URL reads as its host, a
  ref as words, a rounded position as "my location"), else the label, the ref and up to three params, then
  " · via <preview title>" (the preview's own title, not the page's): "Is size 10 in stock for Karhu ikoni 3? · via
  Running shoes". Every value is one line of letters, digits and everyday punctuation, capped (140 for the line,
  200 in all), so a page cannot format, link, mention or command anything. It goes through the composer's own send
  path to Octo (queued behind a busy turn like any message), with `metadata.siteIntent: {previewId, askId, intent,
  ref, params, withheld?, coarsened?}`.
- **Confirm.** An intent with `confirm: true` shows Studio's one-line strip over the frame first ("Send “…” as
  you?", Send or Cancel; Send is off for 600 ms and nothing has focus). No other ask asks for consent: it is visible
  as the person's own message.
- **Status.** `sent` once the message is accepted (at most 3 s after the click, so the page's 5 s never runs out),
  `declined` when nothing was sent, `done` or `failed` when that message's run ends (Studio reads the run's
  `metadata.siteIntent.askId`).

**The controller** (`packages/runtime-controller/src/site_intent.rs`) never trusts `siteIntent`: every dispatch takes
it out of the client's metadata, checks its shape and sizes (4 KB in all, params 2 KB), and puts it back only when
the sender may see an open private preview with that id in this space, adding the preview's own title and port and
`verified: true`. Otherwise it is dropped. Recorded messages (`/messages/record`, steer inputs) cannot carry one.

**Octo** sees a checked site intent as a "Sent from a site" block in its prompt (`runtime-agent` `jobs/site_intent.rs`):
the preview's title and port, then the intent, ref and params as quoted JSON, labelled as page data, never as
instructions. There is no separate result channel; Octo answers through the site's own files, as the skill says
("When someone asks from a site"): it reads `bound.json` (`agent.prompt` is the recipe), adds `instafy.records@1`
records to the intent's `target.records` file, bumps `data/version.json` and runs `instafy bind command <dir> reload
'{}'`, then replies in one line.

## 2b. Location and follow mode (the page's half)

Both talk to the host frame with `{source:"instafy-bind"|"instafy-host", v:1, type, payload}` messages, only with a
frame at an origin the binder lists (§4 Frames) that sent a `layout`. Studio's preview pane is such a host.
- **Location.** `instafyBind.location()` asks the host when its layout says `caps.location: "host"` (the host asks the
  browser once and shows which site has the position), asks the browser on a page of its own or when the host says
  the frame may (`caps.geolocation: true`), and otherwise rejects with code `unavailable`, "Location is not
  available in this preview yet.", never a message about browser settings.
- **Follow mode.** While the host says `present`, the page shares its view (path, query, hash, the element with an id
  at the top, scroll); a follower's copy applies the presenter's. Once a page was given a position, views leave out
  its query, hash and own state unless the presenter shares location (`present.share.location`) or the page says its
  view never holds a position (`follow({locationFree: true})`). A follower never sends its own position.

## 3. `bound.json`

Intents, their param schemas and how each runs:

```jsonc
{
  "version": 1,
  "intents": {
    "check_product": {
      "label": "Check my size", "emoji": "👟",
      "params": { "type": "object", "required": ["url", "size"], "additionalProperties": false,
                  "properties": { "url": { "type": "string", "format": "uri", "maxLength": 500 },
                                  "size": { "type": "string", "maxLength": 12, "pattern": "^[A-Za-z0-9 .,/-]{1,12}$" },
                                  "ref": { "type": "string", "pattern": "^products:[a-z0-9-]{1,40}$" } } },
      "executor": "agent",                       // "script" | "agent"
      "agent": {
        "prompt": "Open {{url}} in the browser. Is EU size {{size}} in stock, and what is the current price? Report what the page shows; do not add to cart.",
        "allowed_origins": ["https://www.shop.example"],  // url params and record URLs must be inside these
        "lane": "assist",                        // "assist" or "capture"; stamped on records
        "timeout_s": 300
      },
      "target": { "records": "data/records/check_product.json" },
      "pending": "item", "cooldown_s": 20, "confirm": false,
      "say": "Is size {size} in stock?"         // agent only: the clicker's chat line for an ask (§2a)
    },
    "read_offer": {
      "label": "Read price (fast)", "executor": "script", "handler": "handlers/read_offer.mjs",
      "params": { "type": "object", "required": ["url"], "properties": { "url": { "type": "string", "format": "uri" } } },
      "lanes": ["open", "local"], "target": { "records": "data/records/read_offer.json" }   // scripts: open, official, local
    }
  }
}
```

**Owner executor (`--agent-executor`) contract.** Off by default. With it, the binder runs agent intents as Octo
turns on the owner's own login, and only for clicks made on this machine: a loopback socket, a loopback `Host` and no
`X-Forwarded-*` header (the same test as admin calls). A click through the preview capability host, a `--public-url`
tunnel or a proxy is still an ask (§2a), and a preview binder with a public link never runs one. That test only
means "the owner" on a machine only the owner uses, so `--agent-executor` is refused in an Instafy runtime
(`RUNTIME_ID` or `CONTROLLER_BASE_URL` set: other members' turns run there). `--dry-run` prints those prompts
instead of dispatching.
1. The binder renders `agent.prompt` with the validated params. Template values are JSON-escaped; params are data,
   never instructions. URL params must be inside `agent.allowed_origins` (400 `policy` otherwise).
2. It appends the safety rules and a fixed output contract: reply with only
   `{"schema":"instafy.records@1","records":[...]}`, every record about the clicked `ref` (JSON-quoted in the prompt).
3. It dispatches into the site's own thread: `POST /projects/:space/conversations/blank` once
   (`threadKind: "bind"`, private to the owner, a child of `--conversation` when given; the id is kept in
   `.bind/agent-thread.json`), then
   `POST /conversations/:thread/messages` with `metadata {writeIntent: false, source: "instafy-bind",
   agentSelection: {active: ["octo"], mentions: ["octo"]}}`. `--agent-conversation <id>` uses an existing
   conversation instead (with a warning when that is your own). A dispatch answered `recorded` (no run) fails at once.
4. It polls `GET /conversations/:id/runs` and `/messages` (newest first, `limit` 50, slower after 30 s). Progress
   events mirror the run status (`awaiting_approval` shows as "Waiting for approval in Instafy") and status messages.
5. A reply that parses as records is taken at once; otherwise the newest reply is taken when the run is finished
   (`success`, `merged`, `failed`, `canceled`, `expired`). If nothing in the reply is usable it sends one repair
   message, and if that fails too, it emits `error invalid`.
6. The apply step stamps `prov.lane`, `prov.observed_at` (the binder's clock, never the model's), builds missing
   ids, and keeps only records about the intent's ref with URLs inside the allowed origins (the URL params' origins
   when `allowed_origins` is absent). Assist and capture records never replace a record from another lane.
7. Cancel and timeout stop the controller job too (`POST /jobs/:job/cancel`); the job keeps its concurrency slot
   until that call returns. Every dispatch, repairs included, counts against the per-site budget
   (`--agent-budget`, default 20 per hour, `.bind/agent-budget.json`); when it is spent intents get 429 `budget`.
8. Tokens: `--access-token`, `INSTAFY_ACCESS_TOKEN`, `SUPABASE_ACCESS_TOKEN` or the saved `instafy login` (re-read
   once after a 401). The runtime job token (`CONTROLLER_ACCESS_TOKEN`) is never used: it ends with the Octo turn
   that started `serve`.
9. `--dry-run` prints the rendered prompt instead of dispatching, so the loop can be tested without an account.
10. Without `--agent-executor` none of this runs: no login is resolved, `serve --detach` drops `INSTAFY_ACCESS_TOKEN`
    and `SUPABASE_ACCESS_TOKEN` from the background binder's environment, and `doctor` does not ask for a login.

**Pages without the bind client.** They cannot send `x-bind-token`, so for them `serve` prints `?k=<token>`;
opening it sets an `HttpOnly; SameSite=Lax` cookie scoped to the site path and redirects to the clean URL. A plain
site (an `index.html` and no `bound.json`) gets the client added to its pages.

## 4. Security

- **Viewer token.** `serve` creates a random token per site and prints the share URL with `#k=<token>`. The client
  reads it once, trades it for an `HttpOnly; SameSite=Lax` site cookie (`POST __bind/session`), removes it from the
  address bar and never exposes it to page scripts; EventSource, polling and the page's own fetches ride on the
  cookie. Pages without the client use the `?k=` cookie handoff above.
- **What the token guards.** Intents, events, jobs, `__bind/records`, `bound.json`, `data/version.json` and
  `data/records/*`. `handlers/`, `test/`, `tests/` and `node_modules/` are never served. Both rules compare the path
  the way a case-insensitive filesystem (macOS, Windows) reads it, lower case with trailing dots, spaces and
  `:stream` suffixes cut, and also the real path of the file it names, so `/Bound.json` or `/Handlers./x.mjs` are
  guarded like their canonical names. The page, its assets, seed data and `client.js` stay public. In gallery mode
  only discovered site folders are served.
- **Admin token.** Commands and confirmations need the admin token from `.bind/admin-token` (mode 0600). The site
  never sees it, and they are accepted only on the binder's loopback address (never through a preview capability
  host, a `--public-url` tunnel or a proxy). The origin server reserves `.bind/` at any depth, so the file API, saves
  and isolated workers' snapshots never carry it. Terminal confirmations need the job id (`y <job>`); a bare `y`
  approves nothing.
- **Streams end.** An SSE stream closes after 60 s and EventSource reconnects (Last-Event-ID replay, no gap), so the
  preview broker's per-request check applies again. A revoked viewer stops receiving events within about 90 s (up to
  60 s left on the stream, plus the broker's cached allow of up to 30 s). One source (the proxy-appended client
  address) holds at most 8 streams; past that its new stream gets 503 and the client polls instead.
- **No credential in the backend.** Ask Octo goes through Studio as the clicker (§2a), so by default the binder
  never reads an Instafy login and cannot spend anyone's quota. Only the owner's `--agent-executor` dispatches turns,
  for the owner's own clicks on this machine.
- **Positions in agent prompts.** An agent intent's prompt (owner executor) carries a viewer's position rounded to
  about 100 m (accuracy, altitude and heading left out); `private_params` reach Octo, which is that intent's handler.
  The site's thread is created private to the owner who serves it. Agent intents never run on a preview binder with
  a public link (`--preview --public-url`). An ask (§2a) carries the position rounded the same way, without
  `private_params`.
- **Public links need the token.** `--preview` is tokenless only on the binder's loopback names and the preview
  capability host; a `--public-url` name needs the viewer token, and `serve` prints that public link with `#k=`.
  `--no-token` cannot be combined with `--public-url`.
- **`serve --detach`** starts the background binder without the runtime job token or other `CONTROLLER_*` secrets
  (it keeps `CONTROLLER_BASE_URL`), `SUPABASE_*` values or credential-like names other than `--allow-env` names (and
  the owner's login only with `--agent-executor`), because every handler can read the binder's `/proc/<pid>/environ`.
- **Origins and hosts.** A request authenticated only by the cookie must come from the site's own origin (or a
  `--public-url`); `x-forwarded-host` counts only with `--trust-proxy`. With `--no-token` or `--preview` (localhost
  only) the `Host` header must be a name the binder was started for, which stops DNS rebinding.
- **Limits.** Params ≤ 4 KB, body ≤ 8 KB; cooldown per (name, `params.ref`); 30 intents per name per minute; 20 jobs
  waiting per site; 2 concurrent jobs per site; identical intents within 60 s are coalesced (up to 10 viewers per
  job); 50 SSE viewers per site (8 per source); the replay buffer is capped at 200 events and 2 MB; records files stay under 200 KB.
  Only finished jobs are evicted from the job list.
- **Records are untrusted.** They go through schema validation, their URLs must be `https:`, and pages render
  strings as text only. Agent records are scoped to the clicked ref and the intent's origins (see the contract).
- **Logs.** Every log line has control characters replaced before it reaches the terminal or `.bind/binder.log`, so
  a ref, handler output or a controller error cannot rewrite the operator's screen. Controller errors reach viewers
  only as a generic message.
- **Script handlers are trusted code.** They run as child processes with cwd = the site, a timeout, and a small
  environment: `HOME` points at `~/.cache/instafy-bind/home`, Instafy and controller variables are never passed, and
  credential-like names (`*_TOKEN`, `*_KEY`, `*SECRET*`, `*PASSWORD*`) declared in `env` need `serve --allow-env NAME`.
  They are not sandboxed: they can read what the owner can. URL params (nested ones too) and `kit.fetch` reach only
  public `http(s)` addresses (private, loopback, LAN, 6to4/Teredo to those are refused, also after redirects and at
  connect time) unless `--allow-local`; credential headers are dropped when a redirect changes origin. `kit.fetch`
  also refuses paths robots.txt disallows for `*` or the major AI user agents (error code `policy`), for the URL and
  every redirect hop (`src/web.mjs`), and a site that does not answer or answers 5xx is error code `unavailable`,
  never a missing page. robots.txt paths are compared normalised (RFC 9309: unreserved escapes decoded, doubled
  slashes folded). The binder keeps no list of named sites: a site's own robots.txt is its policy.
- **Agent prompts** (owner executor) state that page content and parameters are untrusted data, and that the agent
  must not buy, book, sign in or enter credentials, and must stop at CAPTCHAs. That text is a request, not an
  enforcement: the real limits are the dedicated thread, `writeIntent: false`, the per-site budget, origin checks on
  URL params and the apply step's ref and origin scoping. There is no controller-enforced tool profile for
  `source: "instafy-bind"`, which is why the executor is off by default and owner-local only.
- **Asks** go only to the host frame's origin (never `*`); the client counts `ask-status` answers only from that
  origin, for ids it sent.
- **Frames.** Who may host a page: `bound.json` `parentOrigins`, plus, on a preview capability host, the Studio origin
  `instafy preview open` recorded for that preview (the controller's `studioOrigin`, its `PUBLIC_APP_URL`, kept in
  `~/.instafy/cli-preview-state.json`). HTML responses carry `Content-Security-Policy: frame-ancestors 'self'
  <those origins>`, and `health` and `hello` give the client the same list. The client takes host messages (layout,
  asks, location, follow) only from a direct parent at one of them, and where the browser names the parent
  (`ancestorOrigins`) it must be the sender. The preview label is a bearer that also leaks in Origin headers, so
  without this any page that framed the preview URL would become the page's host. A preview with no recorded Studio
  origin (an older CLI or controller) sends no `frame-ancestors`, so Studio can still show it, but its page takes no
  host messages at all: no asks, no host location, no follow.

## 5. What is not here yet

- A structured result channel for asks: Octo writes records into the site's files and reloads open pages (§2a).
- Ask caps across Studio tabs: one ask at a time holds per tab; the controller's six in ten minutes is kept in each
  controller process's memory.
- One Studio origin per controller: a Studio served from any origin other than the controller's `PUBLIC_APP_URL`
  (for example the desktop app's default start page, if it differs) frames previews whose pages take no host
  messages from it.
- The owner executor has run against a mock that mirrors `runtime-controller` (blank thread creation, `recorded`
  dispatches, run statuses, newest-first messages, job cancel), not against a live turn. It has no controller-enforced
  tool profile and no structured result channel; it reads Octo's answer out of chat text.
- Long-lived site WebSockets outlive a revoked viewer (the binder's own SSE streams end after 60 s; §4).
- Attribution of the human who clicked a script intent: the binder knows the token, not the person.
- Durable hosting.
