---
name: instafy-comparing
description: Compare products or options side by side: which items, each one's own page, its values and the reviews asked for, and what a value nobody found says.
context_kind: workflow
context_parent: instafy-browser-automation, instafy-web-research, instafy-interactive-artifacts
routing_keywords: compare, comparing, comparison, versus, side by side, which to buy, which one to buy, which is better, better than, difference between, specs, specifications, warranty, review, reviewer, independent reviews, reviews each, reviews of each
---

# Comparing items

Never prune: yes

For every reader and browser. Pages are found as "Finding a page" in `instafy-browser-automation` says. With the AI's own web search, a comparison looks things up as `instafy-web-research` says, searching first, and uses Instafy's browser only for what search can't reach: a site to use, availability for dates, a sign-in, a page nothing else read.

## The items

- List the models a page you read names, its menu included, then open each one's own page. Never names from memory, never placeholders such as "candidate 1".
- Name: the exact model and generation its official page gives, else the page naming it. A product's official site is its maker's.
- "The latest N": the maker's newest N in its own current lineup, from its own page. A review's guide ranks models; it doesn't date them.

## Values

- A value is often behind a tab, toggle or link of the item's own page (specs, a "Show all specs" toggle, warranty, support, FAQ): open the one for it, in the same pass, before you call the value not found.
- A fact is an item's only when its page names that item; a sibling's page (a hotel of the same group or district, a model of the same line) is not its source.
- Price: the maker's or a shop's own page. Missing or refused: try an allowed shop. Still none: "price unknown", with a page the person can send to Octo. Never remember or guess a price.
- A limit ("under €600"): an item with no price read this turn is listed as "price unknown", never as within it.
- A value read on the item's own page stays. Another page's figure goes beside it under its own label ("<site> list price"), never in its place; where two pages you read disagree, the page shows both.
- A price in a suggestion row or a listing is a lead: open the product page and cite it, "seen <date>". A price for dates comes from the place's own booking form with the dates and guests entered; the final button stays the person's.

## Reviews

- Requested reviews: that many per exact model, from independent publishers, not its maker/shops or a sibling model.
- A review no page you read links to: the AI's own web search finds it ("<exact model> review") when this run has it; else it comes from a reviewer's own site: its home page, its links and its own search box.
- With no search, try up to two reviewers' own sites that way, in the same pass, before a review goes in the missing line. A home page with no review of the model is not a look: search the site with its own box (a search that stays on its site needs no prompt) or open its reviews section, and open the model's review from there. Only once a reviewer's search results or reviews section was read is a review you have no address or link for a value you didn't find, not a page to read: in Instafy's browser it goes in the missing line, never the unread line.
- A review no reviewer's search results or reviews section could be read for (none could be tried, or each one was covered by a notice or stopped you) is "not checked" on the page and goes in neither line. Such reviews are named once in the reply, as not checked, with an offer to read a site the person names.
- Short: "<item>: 1 of 2 reviews found", in the reply and on the page, citing only those reviews.

## A value nobody found

- What a page read says of a value, even in part, fills its cell in the page's words ("in the device's settings; the terms differ by country"), never "I didn't find".
- It reads `Unknown`, with why. One you looked for yourself says where you looked ("price not found on the shop's page"). One Octo's browser looked for and didn't find is said in the words its findings give ("I didn't find the warranty"), naming no page. "I didn't find" is only for a value looked for on a page read or in a search that ran.
