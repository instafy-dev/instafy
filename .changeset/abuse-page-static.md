---
---

The abuse and contact page is also served as a plain HTML file at `/abuse`, so it reads the same without JavaScript; a test keeps it in step with the in-app page. The service worker now keeps a page load as the offline app shell only when it is the app shell, so opening `/abuse` or another file served at its own path no longer replaces it. No package changes.
