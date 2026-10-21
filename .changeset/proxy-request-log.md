---
---

The OpenAI proxy logs one `upstream request` line for each model request it sends upstream, with the run, job and lease attempt its token names, the model asked for, the model it last went upstream as and the model the provider says served it, and either the usage the provider reported, what the provider said when it refused (its error code, type and param and its message, cut short and with key-like text masked), or that the request was cancelled because its client went away or the proxy stopped. A refused request's error message names the provider's code and param after the proxy's own words, 429s included, never the provider's message. Every proxy log line starts with its UTC time. No package changes.
