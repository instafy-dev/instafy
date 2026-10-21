# follow-table

A plain table whose sort and size filter live in the URL query and whose rows have ids. That is all follow mode
needs: framed by Studio, the bind client shares the query and the row at the top of the window while someone
presents, and the followers' copies show the same. The rows are made-up sample data.

```sh
node packages/instafy-bind/bin/instafy-bind.mjs serve packages/instafy-bind/examples/follow-table --port 4181 --preview
```

`tests/browser.e2e.mjs` frames it twice in a Studio-like host and checks a presenter's sort, filter and scroll reach
the follower.
