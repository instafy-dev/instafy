---
"@instafy/cli": patch
---

`instafy login` prints a confirmation code under the sign-in URL, and the step after it now asks you to check that the Studio page shows the same code and press **Connect the CLI**. The page no longer sends the sign-in to the CLI as soon as it opens: it waits for that press, and the terminal then continues on its own. Copying the token from the page and pasting it into the terminal still works. With an older CLI, which prints no code, the page offers only the token to copy, so update to keep connecting without copying.
