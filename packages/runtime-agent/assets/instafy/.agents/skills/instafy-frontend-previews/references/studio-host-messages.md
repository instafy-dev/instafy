# Studio host messages for a previewed site

Read this when a site shown in a Studio preview uses the person's location, or when people will Present and Follow it together.

## A site that uses the person's location

Inside a Studio preview the page cannot call `navigator.geolocation`; the browser refuses it. When the page's URL has `instafy_host=studio`, or a `{source: "instafy-host", type: "layout"}` message arrives from `parent`, ask Studio instead (Studio adds the query only to the first page, and sends the message on every page load, so keep the flag in `sessionStorage`): `parent.postMessage({source: "<your site's short name>", v: 1, type: "location-request", payload: {id: "<short id>", watch: false}}, "*")`, and read `{source: "instafy-host", type: "location", payload: {id, coords}}` or `type: "location-error"` (`payload.code`: `denied`, `unavailable`, `timeout`, `stopped` or `hidden`) from `message` events whose `event.source` is `parent`. Use `watch: true` to follow the person, and send `type: "location-stop"` with the same id to end it. Elsewhere, use `navigator.geolocation` as usual. Studio asks the person once and shows them which sites got their location, so do not add a consent dialog of your own. Show a short note for each error code; `stopped` means the person turned location off for this site in Studio's 📍 menu, and only they can turn it back on there. Do not put the person's position in a URL, a public page or a file you commit.

## Let people present it and follow along

In Studio a member can **Present** a preview and the others **Follow** it live, each in their own copy of the site. Studio offers Present only for a page that says it can share its view. When you build a site people will look at together (a map, a plan, a list to decide on), add this to the page:

- Read host messages only when `event.source === window.parent`, and post `layout-ack`, `view` and `interact` to the origin of the host's `layout` message: `window.parent.postMessage(message, hostOrigin)`, never `"*"`.
- When the page is in a frame (`window.parent !== window`) and gets `{source:"instafy-host", v:1, type:"layout"}`, reply `{source:"site", v:1, type:"layout-ack", payload:{supports:["view"]}}` (`source` is any short lowercase name, the same on every message).
- After `{type:"present", on:true}` and until `on:false`, post `{source, v:1, type:"view", payload}` whenever what is visible changes. `payload` is small JSON (at most 2 KB) describing the view: the open tab, the selection, the sort and filters, the scroll or the map area. Never put the person's own position in it.
- A view is shared, non-secret state only: never a token, a key, a private note or anything only this person may see.
- On `{type:"apply-view", payload, smooth}`, show that view (animate when `smooth`). When the person scrolls, pans or clicks on their own, post `{source, v:1, type:"interact"}`.
- An `apply-view` or `apply-tap` comes from another person, so treat it as untrusted input. Read only the keys you expect, of the types you expect, and ignore everything else.
- Applying a view only changes what is shown. It never saves, buys, sends, deletes or calls a backend route that changes anything, never fetches or opens a URL taken from it, and never puts a value into HTML or code (no `innerHTML` or `eval`). Show `from.name` as text only.
- Keep the view in the URL query where you can (tab, sort, filters) and give rows stable ids, so a view is easy to share and apply.
