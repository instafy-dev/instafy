---
---

Sites in a Studio preview can use the person's location without a prompt per site. The frame still may not call the browser's geolocation; a site asks Studio with a `location-request` message, Studio asks the browser once for Instafy, answers only the frame on screen at its own origin, and shows 📍 in the preview's bar and tab for every site that got it, with Stop (which sticks until the person shares again) and a list in Settings → Profile → Location. The desktop app now has a permission handler on Studio's window: geolocation only for Studio's own top frame after one remembered native question, never for a frame inside it, and frames get only fullscreen, clipboard writes and pointer lock. The previews skill tells Octo how a site asks. No package changes.
