# Conversation views and composer queue

This local fixture mounts the production conversation tabs, chat composer and
queue actions with isolated sample data. It does not authenticate, dispatch a
real message or require a controller.

From `packages/frontend`, start the preview:

```sh
pnpm exec vite --config tests/fixtures/conversation-view-tabs/vite.config.ts
```

Open `/tests/fixtures/conversation-view-tabs/index.html?context=composer&queue=3&navigation=compact`.
Use `theme=dark` for dark mode, `placement=header` for desktop navigation,
`queue=6` for a scrolling queue, `stash=1` for a saved draft, and `draft=example`
to exercise protection of an existing composer draft. The default page without
`context=composer` previews the view tabs, with optional `files` and `approval`.

The required browser UI suite includes `queue-composer.spec.ts` and
`conversation-surfaces.spec.ts`. They cover draft protection, edit/save/cancel
order, sending and removal, mouse/touch/keyboard reordering, read-only controls,
narrow widths, themes and the joined composer toolbar. Controller persistence,
authorization and retry behavior are covered separately by the Rust send queue
database tests.
