---
---

`TUNNEL_DOMAIN` is now read the same way as `PREVIEW_DOMAIN` (a leading `*.` is accepted), and a value that is a single label or a public suffix such as `site` or `co.uk` matches no tunnel instead of every site under it. The controller logs a warning at startup when `TUNNEL_DOMAIN` is set but unusable. Studio's dev server ignores a single-label value too. Tests now also check that no other domain is treated as a tunnel domain when the setting is unset. No package changes.
