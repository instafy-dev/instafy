---
---

In the Shared Browser, Octo's form steps are judged by the submission the browser actually makes. A search field whose default button posts to another site, a label or child of a hidden submit button, or a form whose relative action resolves against a `<base href>` on another site now asks for that site and binds the step's approval to it; under routine browsing such a click no longer goes through as an ordinary click. A form step that would open another window (`formtarget="_blank"`, a `<base target>`, an unknown window name) is refused before any prompt, and a dialog submission has no destination. A real-Chromium fixture checks every case of the shared table against what Chromium sends. No package changes.
