---
---

A team lead's final checkpoint now states which preview cards the run's agents opened, each with its agent and whether its files were saved, or that none was opened, with the rule that the reply mentions a card only when this record names one. A lead's reply had told the user to "open it from the card above" when no agent had opened a preview. The plan-group status lists each lane's `openedPreviews`. The Octo turn eval gains a `reply_card_exists` must check: a reply that sends the person to a card fails when the turn posted none. No package changes.
