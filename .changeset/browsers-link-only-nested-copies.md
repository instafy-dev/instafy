---
---

Octo's Shared Browser and the desktop app's Personal Browser find more copies of link-only sites, with the same matcher as `instafy web read`: a copy inside another wrapper, a site written anywhere in a wrapper's path or query, hosts written with soft hyphens, zero-width characters or invalid punycode, and addresses of any length (a very long address was let through before). A page or frame Octo loads whose answer says it is a copy of a link-only site (an archive's Memento `rel="original"`, as at a short archive.ph address) is stopped before it renders. A check that cannot see through a copy refuses it. No package changes.
