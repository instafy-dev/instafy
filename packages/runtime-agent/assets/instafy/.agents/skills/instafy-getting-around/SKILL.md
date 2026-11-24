---
name: instafy-getting-around
description: Get from one place to another: a route or public transport from the operator's own journey planner, and what a route's finding and a page built from it say.
context_kind: workflow
context_parent: instafy-browser-automation, instafy-web-research, instafy-interactive-artifacts
routing_keywords: get there, getting there, get from, how to get to, how do i get to, how do i get from, how can i get to, how can i get from, how to reach, how do i reach, how can i reach, directions, route to, route from, metro route, tram route, bus route, train route, walking route, walk from, way from, journey planner, public transport, public transit, timetable, bus, metro, subway, underground, u-bahn, s-bahn, tram, ferry, train from, train to, trains from, trains to, next train, by train
---

# Getting around

Never prune: yes

For every reader and browser. Pages are found as "Finding a page" in `instafy-browser-automation` says.

## Where a route comes from

- Look for a route only when the message asks for one, or carries on one that did.
- A route comes from the transit operator's own journey planner, reached from the operator's site. A listing, a map snippet or a guide only leads to it; never a route from memory.
- In the planner, choose the start, the stop nearest the place (the one the place's own page names, else your pick) and the person's day and time (else a daytime hour); then press its button and read the route.
- Choose each stop by clicking it in its field's own suggestions, not with Enter, which can send the form before a stop is chosen. Press the button once, when every field is filled. A click's answer saying a field still holds what was typed means none of its suggestions is chosen: click one.
- Say there's no route only when the planner's own results say so. When a stop couldn't be chosen, say that instead.
- If the browser refuses a planner's field as a secret, filling it is the person's step: highlight it with `request_human_input` and say what goes in it. Don't try it on another copy of that planner in this message.
- A planner you didn't send is "not run", never "checked" or "no result". Say the last step you took ("I typed the start; I couldn't choose a stop"), and say "again" only for a step this turn took. Say a step that didn't work as your own, never as the planner refusing it.

## When the planner can't be run

- When a planner's fields never show, one is the person's, or no stop could be chosen, open the place's own getting-there tab or question (click a closed one open) before you highlight a field or end. Give the place's own lines or, where its page gives none, an official city or tourism page's: every line and stop it names, closures too, as the words of the page they're on, named by its site and linked; a city or tourism page's lines are that page's, never the place's. Say "the planner wasn't run, so no times". A listing, a map snippet and memory stay out.
- A planner that showed no fields in this chat isn't opened the same way again (its address, whatever values it carries): give its link and the start and stop to type in it.
- A planner whose list opened with no suggestion isn't typed into the same way again in this message: open the operator's own planner page once, from its menu's journey link, else give its link and the start and stop to type in it.

## A route's finding

- A route's finding, like your reply, names its end stop and whose pick it is ("<stop>, Octo's pick: the place's page names no stop"), what it leaves out ("the walk to the place isn't in it") and the day and time its legs run, not the page header's.

## A page or reply built from a route

- A route ends at the stop its finding names. Unless the person named that stop or a finding says the place's own page names it, say on the page that it's Octo's pick and that the walk from it to the place isn't checked.
- A page asked for after a route turn carries that turn's lines and their sources, with "the planner wasn't run" where it wasn't, and doesn't run the planner again.
