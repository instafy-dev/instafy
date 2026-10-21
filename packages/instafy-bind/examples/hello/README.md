# hello

The smallest bound site. One page, one script intent, one agent intent.

- **👋 Ask the binder** sends the `hello` intent. The binder runs `handlers/hello.mjs`, which streams three
  progress steps and returns one `claim` record. The binder validates it, writes `data/records/hello.json` and
  streams it to every open viewer.
- **🐙 Ask Octo** sends `ask_octo`, the same question as an Octo turn (agent executor). Without an Instafy login,
  run the binder with `--dry-run` to see the rendered prompt instead.
- The page also reacts to host **commands**: `toast {text}`, `highlight {refs, ms}` and `select {ref}`.

## Run it

From the repo root:

```sh
node packages/instafy-bind/bin/instafy-bind.mjs serve packages/instafy-bind/examples/hello --port 4173
```

Open the printed URL (it ends in `#k=<viewer token>`). Open it in a second window too, type a name in one and
click **Ask the binder**: both windows show the progress and the new record.

Drive the page from a terminal (this is what Octo does when you say "highlight Kim"):

```sh
node packages/instafy-bind/bin/instafy-bind.mjs command packages/instafy-bind/examples/hello toast '{"text":"Hi from chat"}'
node packages/instafy-bind/bin/instafy-bind.mjs command packages/instafy-bind/examples/hello highlight '{"refs":["hello:kim"],"ms":3000}'
```

See the agent prompt without dispatching it:

```sh
node packages/instafy-bind/bin/instafy-bind.mjs serve packages/instafy-bind/examples/hello --port 4173 --dry-run
```

Run the handler alone (it reads the intent on stdin and writes NDJSON):

```sh
echo '{"intent":{"params":{"name":"Kim"}}}' | node packages/instafy-bind/examples/hello/handlers/hello.mjs
```

## Files

| File | What |
|---|---|
| `index.html` | The page: form, records list, live event log. Loads `__bind/client.js` |
| `bound.json` | Two intents: `hello` (script) and `ask_octo` (agent) |
| `handlers/hello.mjs` | The script handler (stdin JSON in, NDJSON out, never writes files) |
| `data/records/hello.json` | Written by the binder |

The handler stamps `prov.lane: "local"` because a script on this machine produced the record.
