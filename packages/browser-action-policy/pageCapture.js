"use strict";

/*
 * Reading a page a person chose to send, shared by the Desktop Personal
 * Browser and the hosted Shared Browser.
 *
 * - pageSecretSignalsInPage(sources) runs inside the page and answers four
 *   yes/no questions about secrets on it (see redaction.js,
 *   redactPageObservation). The Shared Browser's agent snapshots use it too.
 * - captureSentPage(redaction, options) runs inside the page, in an isolated
 *   world where redaction.js has been loaded as well. It reads the page's
 *   address, title, rendered text and up to 200 links once, masks them with
 *   the same rules as an agent snapshot, and returns only the masked result.
 *   A secret screen, a failed check or a failed mask returns no text and no
 *   links at all.
 * - pageLinksInPage(limit) runs inside the page and lists its web links (text
 *   and target) in document order, for a host that reads the page another way.
 *
 * Nothing here keeps state, registers a listener or reads the page again
 * later: one call reads one page once.
 *
 * Plain script with no imports. In CommonJS it exports its API; evaluated
 * where `module` is undefined it sets `globalThis.__instafyBrowserPageCapture`.
 */
(function defineBrowserPageCapture(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.__instafyBrowserPageCapture = api;
  }
})(typeof globalThis === "object" ? globalThis : null, function browserPageCaptureFactory() {
  /** The most page text one sent page carries, after masking. */
  const MAX_SENT_PAGE_TEXT_CHARS = 50_000;
  // Text is masked with this much more than it keeps, so a key cut in two at
  // the reading limit is masked whole and then dropped with the margin.
  const SENT_PAGE_MASK_MARGIN_CHARS = 2_048;
  const MAX_SENT_PAGE_TITLE_CHARS = 1_000;
  const MAX_SENT_PAGE_URL_CHARS = 8_192;
  /** The most links one sent page carries. */
  const MAX_SENT_PAGE_LINKS = 200;
  const MAX_SENT_PAGE_LINK_TEXT_CHARS = 200;
  const MAX_SENT_PAGE_LINK_URL_CHARS = 2_048;

  /** The regular-expression sources pageSecretSignalsInPage needs. */
  function pagePolicySources(redaction) {
    return {
      kind: "page-policy",
      secretPatterns: [...redaction.KNOWN_SECRET_PATTERN_SOURCES],
      credentialContext: redaction.CREDENTIAL_CONTEXT_SOURCE,
      placeholder: redaction.PLACEHOLDER_SOURCE,
      maskedText: redaction.MASKED_TEXT_SOURCE,
    };
  }

  // Runs inside the page. Every check returns a boolean; no field value, code
  // block text or masked text is part of the result. Open shadow roots are
  // searched too. A failure returns null and the page is withheld.
  function pageSecretSignalsInPage(sources) {
    try {
      const clean = (value, limit = 2_000) =>
        typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
      const secretPatterns = sources.secretPatterns.map((source) => new RegExp(source));
      const credentialContextPattern = new RegExp(sources.credentialContext, "iu");
      const placeholderPattern = new RegExp(sources.placeholder, "i");
      const maskedTextPattern = new RegExp(sources.maskedText, "u");
      const revealLabelPattern = /(?<![\p{L}\p{N}])(?:reveal|show|view|copy|unhide|display|anzeigen|einblenden|kopieren|zeigen|ansehen)(?![\p{L}\p{N}])|(?<![\p{L}])eye(?:[-_]?(?:icon|open|off|slash|closed|fill|outline))?(?![\p{L}])|(?<![\p{L}])eye(?=icon|open|off|slash)|visibility|clipboard/iu;
      const uuidValuePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const hexValuePattern = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
      const valueEntropy = (value) => {
        const counts = new Map();
        for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
        let entropy = 0;
        for (const count of counts.values()) {
          const probability = count / value.length;
          entropy -= probability * Math.log2(probability);
        }
        return entropy;
      };
      const looksLikeSecretValue = (raw, credentialContext) => {
        if (typeof raw !== "string") return false;
        const value = raw.trim();
        if (value.length < 16 || value.length > 16_384 || placeholderPattern.test(value)) return false;
        if (secretPatterns.some((pattern) => pattern.test(value))) return true;
        if (/\s/.test(value) || value.length < 20 || value.length > 512) return false;
        if (!credentialContext && (uuidValuePattern.test(value) || hexValuePattern.test(value))) return false;
        return /[A-Za-z]/.test(value) && /[0-9]/.test(value) && valueEntropy(value) >= 3.5;
      };
      const scanElements = (visit) => {
        const roots = [document];
        let scanned = 0;
        while (roots.length > 0 && scanned < 20_000) {
          const root = roots.shift();
          const elements = typeof root?.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
          for (const element of elements) {
            scanned += 1;
            if (visit(element) === true) return true;
            if (element && element.shadowRoot && typeof element.shadowRoot.querySelectorAll === "function") {
              roots.push(element.shadowRoot);
            }
            if (scanned >= 20_000) break;
          }
        }
        return false;
      };
      const elementTag = (element) => (typeof element?.tagName === "string" ? element.tagName.toUpperCase() : "");
      const elementAttribute = (element, name) =>
        typeof element?.getAttribute === "function" ? element.getAttribute(name) : null;
      const elementText = (element) => clean(element?.textContent ?? element?.innerText ?? "", 2_000);
      const isDialog = (element) =>
        elementTag(element) === "DIALOG" ||
        ["dialog", "alertdialog"].includes(elementAttribute(element, "role")) ||
        elementAttribute(element, "aria-modal") === "true";
      const labelTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "LEGEND", "TH", "LABEL", "DT", "CAPTION"]);
      const credentialContext =
        credentialContextPattern.test(clean(document.title, 1_000)) ||
        scanElements((element) => {
          const label =
            labelTags.has(elementTag(element)) || elementAttribute(element, "role") === "heading"
              ? elementText(element)
              : isDialog(element)
                ? clean(elementAttribute(element, "aria-label"))
                : "";
          return Boolean(label) && credentialContextPattern.test(label);
        });
      const codeTags = new Set(["CODE", "PRE", "KBD", "SAMP", "OUTPUT"]);
      let secretField = false;
      let secretCode = false;
      let maskedNearReveal = false;
      scanElements((element) => {
        const tag = elementTag(element);
        if (!secretField && (tag === "INPUT" || tag === "TEXTAREA")) {
          const type = String(element.type || elementAttribute(element, "type") || "").toLowerCase();
          const readOnly =
            element.readOnly === true || elementAttribute(element, "readonly") !== null ||
            element.disabled === true || elementAttribute(element, "disabled") !== null;
          if (readOnly && type !== "password" && type !== "hidden" && looksLikeSecretValue(element.value, credentialContext)) {
            secretField = true;
          }
        }
        if (!secretCode && codeTags.has(tag) && looksLikeSecretValue(elementText(element), credentialContext)) {
          secretCode = true;
        }
        if (
          !maskedNearReveal &&
          (tag === "BUTTON" || tag === "A" || elementAttribute(element, "role") === "button" ||
            elementAttribute(element, "onclick") !== null)
        ) {
          const label = [
            elementAttribute(element, "aria-label"), elementAttribute(element, "title"),
            elementAttribute(element, "class"), elementAttribute(element, "data-icon"), elementText(element),
          ].filter(Boolean).join(" ");
          // A link to another page counts only when its own label names a
          // credential; "View invoice" beside a masked card number does not.
          let pageLink = false;
          if (tag === "A") {
            try {
              pageLink =
                ["http:", "https:"].includes(new URL(String(element.href || "")).protocol) &&
                !String(elementAttribute(element, "href") || "").startsWith("#");
            } catch (_) {
              pageLink = false;
            }
          }
          if (revealLabelPattern.test(label) && (!pageLink || credentialContextPattern.test(label))) {
            let ancestor = element.parentElement;
            for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
              // Only a small container around the control, never a whole card or page.
              const ancestorText = typeof ancestor.textContent === "string" ? ancestor.textContent : "";
              if (ancestorText.length <= 400 && maskedTextPattern.test(elementText(ancestor))) {
                maskedNearReveal = true;
                break;
              }
            }
          }
        }
        return secretField && secretCode && maskedNearReveal;
      });
      return { credentialContext, secretField, secretCode, maskedNearReveal };
    } catch (_) {
      return null;
    }
  }

  // Runs inside the page. Its links that lead to a web page (http and https
  // only, so javascript:, data: and other schemes are dropped), in document
  // order and open shadow roots included, each with its visible text (or its
  // label, title or image text), the same target and text only once. Returns
  // raw values: maskSentPage masks them. Self-contained, so a host can run its
  // source on its own.
  function pageLinksInPage(limit) {
    try {
      const max = Math.max(0, Math.min(Number(limit) || 0, 1_000));
      const links = [];
      const seen = new Set();
      const roots = [document];
      let scanned = 0;
      const clean = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 500) : "");
      while (roots.length > 0 && links.length < max && scanned < 20_000) {
        const root = roots.shift();
        const elements = typeof root?.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
        for (const element of elements) {
          scanned += 1;
          if (element && element.shadowRoot && typeof element.shadowRoot.querySelectorAll === "function") {
            roots.push(element.shadowRoot);
          }
          const tag = typeof element?.tagName === "string" ? element.tagName.toUpperCase() : "";
          if ((tag === "A" || tag === "AREA") && typeof element.getAttribute === "function" && element.getAttribute("href") !== null) {
            let href = "";
            try {
              // An SVG link's href is an object, not the address: read its attribute.
              const raw = typeof element.href === "string" ? element.href : element.getAttribute("href");
              const url = new URL(String(raw || ""), document.baseURI);
              if (url.protocol === "http:" || url.protocol === "https:") href = url.href;
            } catch (_) {
              href = "";
            }
            if (href) {
              const image = typeof element.querySelector === "function" ? element.querySelector("img[alt]") : null;
              const text =
                clean(element.innerText) || clean(element.textContent) || clean(element.getAttribute("aria-label")) ||
                clean(element.getAttribute("title")) || clean(element.getAttribute("alt")) ||
                clean(image ? image.getAttribute("alt") : "");
              const key = `${href}\n${text}`;
              if (!seen.has(key)) {
                seen.add(key);
                links.push({ text, href });
              }
            }
          }
          if (links.length >= max || scanned >= 20_000) break;
        }
      }
      return links;
    } catch (_) {
      return [];
    }
  }

  /**
   * The links a sent page may carry: web links only (javascript:, data: and
   * other schemes dropped), at most MAX_SENT_PAGE_LINKS. Without a way to tell
   * link-only sites apart (`linkOnlySite`), none: a link Octo cannot be told
   * to leave alone is not sent.
   */
  function sendableLinks(rawLinks, linkOnlySite) {
    if (typeof linkOnlySite !== "function" || !Array.isArray(rawLinks)) return [];
    const links = [];
    for (const link of rawLinks) {
      if (links.length >= MAX_SENT_PAGE_LINKS) break;
      const href = typeof link?.href === "string" ? link.href.trim() : "";
      let url;
      try {
        url = new URL(href);
      } catch (_) {
        continue;
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.href.length > MAX_SENT_PAGE_LINK_URL_CHARS) continue;
      links.push({ text: typeof link.text === "string" ? link.text.slice(0, MAX_SENT_PAGE_LINK_TEXT_CHARS) : "", href: url.href });
    }
    return links;
  }

  function withheldResult(url) {
    return { url, title: "", text: "", secretScreen: true, truncated: false, links: [] };
  }

  /**
   * Masks one page a person chose to send. `page` holds what was read:
   * `{ url, title, text, signals, links }`, where `signals` is null when the
   * page's secret checks failed and `links` is what pageLinksInPage listed.
   * `withhold` keeps a page withheld that the browser already withholds from
   * the agent; `linkOnlySite(address)` names the link-only site an address is
   * on, or null. Returns `{ url, title, text, secretScreen, truncated, links }`,
   * all masked; a secret screen carries no title, text or links.
   */
  function maskSentPage(redaction, page, options) {
    const withhold = Boolean(options && options.withhold) || !page || !page.signals;
    const rawText = typeof page?.text === "string" ? page.text : "";
    const limit = MAX_SENT_PAGE_TEXT_CHARS;
    // The text is masked within a window of the limit plus the margin. When
    // the page has more than that, the window's last characters may hold part
    // of a key that no mask recognises. A mask can make the text before them
    // shorter or longer, so the margin is dropped from the masked text itself,
    // never at a fixed offset of the raw text.
    const windowCut = rawText.length > limit + SENT_PAGE_MASK_MARGIN_CHARS;
    let maskedUrl = "";
    try {
      maskedUrl = redaction.redactUrl(String(page?.url || "")).text.slice(0, MAX_SENT_PAGE_URL_CHARS);
      const linkOnlySite = options && options.linkOnlySite;
      const links = sendableLinks(page?.links, linkOnlySite);
      // Link texts are masked as the page's control names are, in the page's
      // own credential context.
      const view = redaction.redactPageObservation({
        url: String(page?.url || ""),
        title: String(page?.title || "").slice(0, MAX_SENT_PAGE_TITLE_CHARS),
        text: rawText.slice(0, limit + SENT_PAGE_MASK_MARGIN_CHARS),
        names: links.map((link) => link.text),
        signals: page?.signals || null,
        withhold,
      });
      if (view.secretScreen) return withheldResult(view.url.slice(0, MAX_SENT_PAGE_URL_CHARS));
      const keep = Math.max(
        0,
        Math.min(limit, windowCut ? view.text.length - SENT_PAGE_MASK_MARGIN_CHARS : view.text.length),
      );
      return {
        url: view.url.slice(0, MAX_SENT_PAGE_URL_CHARS),
        title: view.title,
        text: view.text.slice(0, keep),
        secretScreen: false,
        truncated: rawText.length > limit || view.text.length > keep,
        links: links.map((link, index) => {
          const site = linkOnlySite(link.href);
          return {
            text: typeof view.names[index] === "string" ? view.names[index] : "",
            href: redaction.redactUrl(link.href).text.slice(0, MAX_SENT_PAGE_LINK_URL_CHARS),
            ...(typeof site === "string" && site ? { linkOnly: site } : {}),
          };
        }),
      };
    } catch (_) {
      // A page that could not be masked is never sent.
      return withheldResult(maskedUrl);
    }
  }

  /**
   * Runs inside the page, in an isolated world that also holds redaction.js.
   * Only http and https pages are read; anything else answers
   * `{ unsupported: true }`. `options.linkOnly`, `{ api, sites }`, is
   * linkOnly.js's API and the web-research skill's list, which mark the links
   * to link-only ("no-agents") sites; without a list that compiles the page
   * goes without its links.
   */
  function captureSentPage(redaction, options) {
    const location = globalThis.location;
    const protocol = String(location?.protocol || "");
    if (protocol !== "http:" && protocol !== "https:") return { unsupported: true };
    let signals = null;
    try {
      signals = pageSecretSignalsInPage(pagePolicySources(redaction));
    } catch (_) {
      signals = null;
    }
    let text = "";
    try {
      const body = globalThis.document?.body;
      text = body ? String(body.innerText ?? body.textContent ?? "") : "";
    } catch (_) {
      text = "";
    }
    // Runs of blank lines say nothing; keep paragraphs apart with one.
    text = text.slice(0, (MAX_SENT_PAGE_TEXT_CHARS + SENT_PAGE_MASK_MARGIN_CHARS) * 2)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    let linkOnlySite = null;
    try {
      const linkOnly = options && options.linkOnly;
      const list = linkOnly && linkOnly.api && linkOnly.sites ? linkOnly.api.linkOnlyListFrom(linkOnly.sites).list : null;
      if (list) {
        // Only a site whose terms bar agents is link-only. A "no-reuse" site
        // may be opened and read (its content is not reused), so its links go
        // unmarked, as on the Personal Browser.
        linkOnlySite = (address) => {
          const hit = linkOnly.api.linkOnlyMatch(list, address);
          return hit && linkOnly.api.barsAgents(hit) ? hit.site : null;
        };
      }
    } catch (_) {
      linkOnlySite = null;
    }
    const links = linkOnlySite ? pageLinksInPage(MAX_SENT_PAGE_LINKS) : [];
    return maskSentPage(
      redaction,
      { url: String(location.href || ""), title: String(globalThis.document?.title || ""), text, signals, links },
      { withhold: Boolean(options && options.withhold), linkOnlySite },
    );
  }

  return Object.freeze({
    MAX_SENT_PAGE_TEXT_CHARS,
    MAX_SENT_PAGE_LINKS,
    SENT_PAGE_MASK_MARGIN_CHARS,
    pagePolicySources,
    pageSecretSignalsInPage,
    pageLinksInPage,
    maskSentPage,
    captureSentPage,
  });
});
