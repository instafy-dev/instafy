---
---

A public tunnel grant now becomes `active` once its site answers, instead of saying "issuing" for its whole life. Only previews were ever promoted, on their own routes, so a tunnel an agent or the runtime started stayed "issuing" in `GET /projects/:project_id/tunnels` while it served traffic. The tunnel list now asks the broker's probe about each grant that is still issuing, is not a preview and has not expired, at most every 10 s per grant (up to 8 per list, waiting at most 3 s). The grant becomes active, with `tunnel.status_updated`, once a probe sees the site answer. A grant past its `expires_at` is listed as `expired` instead of `issuing` or `active`; the stored status and every limit, which already check `expires_at`, are unchanged. No package changes.
