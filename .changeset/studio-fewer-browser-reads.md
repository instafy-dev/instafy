---
---

Studio reads Instafy's browser less while nothing changes. During a run the action log is still read every second while the agent acts, and each empty read doubles the wait up to 4 s; the tab list is read every 2.5 s while it changes and up to every 5 s while it does not. Waiting for Instafy's browser to start reads its state every 500 ms at first and every 2 s after a few seconds (63 reads in a two-minute wait instead of 240), and a failed capability read is not repeated while the tab is hidden. In a modelled 20-minute session with the browser open, three waits for a browser that never opened and a preview open for 5 minutes, these sources make about half the requests they did. No package changes.
