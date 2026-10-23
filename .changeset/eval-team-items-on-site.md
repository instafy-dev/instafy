---
---

The Octo turn eval has a new must check, `team_items_on_site`: a team's page has to name every item the team
planned a lane for (each lane's label; a lane over several stops counts as each). A line where the page says what it
could not show ("Not found yet: …") does not count as showing the item. Before, a trip map that left out two of the
stops the person asked for still passed. Eval scripts only; no package changes.
