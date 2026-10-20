"use strict";

/*
 * Personal Browser step classifier.
 *
 * classifyStep(op, target, ctx) -> { verdict, category, reason, code? }
 *   verdict  "allow" | "ask" | "refuse"
 *   category what the step is, used to title the approval dialog
 *   code     the refusal code for a "refuse" verdict
 *
 * A free ("allow") verdict only ever comes from structure: tag, role, link
 * shape, form method, page area. Label words only add risk. The one exception
 * is the short list of cookie dismissals and page numbers, which also needs
 * the right structure.
 *
 * Plain script: it uses the redaction module's credential words and nothing
 * else, so it can be embedded beside that module in other browser hosts.
 */
(function defineBrowserActionPolicy(root, factory) {
  const redaction =
    typeof module === "object" && module && module.exports && typeof require === "function"
      ? require("./personalBrowserRedaction")
      : root && root.__instafyBrowserRedaction;
  const api = factory(redaction);
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.__instafyBrowserActionPolicy = api;
  }
})(typeof globalThis === "object" ? globalThis : null, function browserActionPolicyFactory(redaction) {
  if (!redaction || typeof redaction.CREDENTIAL_CONTEXT_SOURCE !== "string") {
    throw new Error("The browser action policy needs the redaction module.");
  }

  const START = "(?<![\\p{L}\\p{N}])";
  const END = "(?![\\p{L}\\p{N}])";
  const words = (list) => new RegExp(`${START}(?:${list.join("|")})${END}`, "iu");
  const anywhere = (list) => new RegExp(`(?:${list.join("|")})`, "iu");

  const credentialNoun = new RegExp(redaction.CREDENTIAL_CONTEXT_SOURCE, "iu");

  const PURCHASE = words([
    "buy", "buy\\s+now", "purchase", "pay", "pay\\s+now", "payment", "checkout", "check\\s+out",
    "place\\s+order", "order\\s+now", "subscribe", "upgrade", "add\\s+to\\s+(?:cart|basket|bag)",
    "kaufen", "jetzt\\s+kaufen", "bezahlen", "zahlen", "zahlungspflichtig", "bestellen", "abonnieren",
    "zur\\s+kasse", "upgraden", "in\\s+den\\s+warenkorb",
  ]);
  const TRANSFER = new RegExp(
    `${START}(?:transfer|transfers|withdraw|withdrawal|payout|send\\s+money|wire)${END}|überweis|auszahl`,
    "iu",
  );
  const CREDENTIAL_VERB = words([
    "create", "generate", "new", "add", "roll", "rotate", "regenerate", "revoke", "reset", "change", "renew",
    "erstellen", "generieren", "neu", "neue", "neuen", "neuer", "neues", "anlegen", "hinzufügen",
    "erneuern", "widerrufen", "zurücksetzen", "ändern", "sperren",
  ]);
  const PERMISSION = words([
    "invite", "share", "grant", "permission", "permissions", "access", "role", "roles",
    "add\\s+(?:member|members|user|users|people|collaborator|collaborators|seat|seats)",
    "make\\s+public", "authori[sz]e", "allow", "approve", "connect",
    "make\\s+(?:an?\\s+)?(?:admin|administrator|owner|member|moderator)", "(?:set|mark)\\s+as\\s+(?:admin|owner)",
    "promote", "demote", "transfer\\s+ownership", "change\\s+role",
    "einladen", "freigeben", "berechtigung", "berechtigungen", "rolle", "rollen", "zugriff",
    "teilen", "autorisieren", "erlauben", "genehmigen", "verbinden",
    "zum\\s+(?:admin|administrator|eigentümer|inhaber)\\s+machen", "als\\s+(?:admin|administrator)",
  ]);
  const DESTRUCTIVE = words([
    "delete", "remove", "erase", "destroy", "archive", "cancel", "deactivate", "disable", "leave",
    "unsubscribe", "discard", "clear", "sign\\s*out", "log\\s*out", "logout", "signout", "unlink",
    "disconnect", "close\\s+account", "close\\s+(?:workspace|organi[sz]ation|team|subscription)",
    "log\\s*off", "logoff", "terminate", "reset", "revoke", "wipe", "purge",
    "trash", "move\\s+to\\s+(?:trash|bin)", "bin", "block", "unblock", "ban", "kick",
    "report\\s+(?:spam|abuse|user|account|this|message|post|as)", "mark\\s+as\\s+spam",
    "löschen", "entfernen", "kündigen", "stornieren", "archivieren", "deaktivieren", "abmelden",
    "austragen", "verwerfen", "leeren", "trennen", "abbestellen", "beenden", "ausloggen", "auflösen",
    "widerrufen", "zurücksetzen", "(?:konto|account|abo|abonnement|mandant|firma|unternehmen)\\s+schließen",
    "papierkorb", "in\\s+den\\s+papierkorb", "blockieren", "sperren", "melden", "als\\s+spam\\s+markieren",
  ]);
  const DOWNLOAD = new RegExp(
    `${START}(?:backup|herunterladen|exportieren|datev|csv|tsv|xlsx?|pdf|ofx|qif|zip|mt940|camt)${END}|export|download`,
    "iu",
  );
  const MESSAGE = words([
    "send", "post", "publish", "reply", "comment", "tweet", "share\\s+post",
    "senden", "absenden", "versenden", "verschicken", "veröffentlichen", "antworten", "kommentieren", "posten",
  ]);
  // Commit words keep a labelled control out of the free menu, tab and
  // navigation rules. Bookkeeping verbs that change records belong here.
  const COMMIT = words([
    "save", "submit", "confirm", "create", "add", "new", "edit", "update", "apply", "book", "reserve",
    "sign", "accept", "agree", "continue", "next", "finish", "done", "ok", "yes", "enable", "activate",
    "assign", "import", "upload", "start", "run", "install", "generate", "rename", "move", "copy",
    "speichern", "bestätigen", "erstellen", "anlegen", "hinzufügen", "neu", "neue", "neuen", "neuer",
    "neues", "bearbeiten", "ändern", "aktualisieren", "übernehmen", "buchen", "festschreiben",
    "abschließen", "zuordnen", "akzeptieren", "zustimmen", "weiter", "fertig", "aktivieren",
    "importieren", "hochladen", "ja", "starten", "ausführen", "umbenennen", "verschieben", "kopieren",
    "mark", "markieren", "pay\\s+off", "settle", "verbuchen", "ausgleichen",
    "duplicate", "duplizieren", "clone", "klonen", "restore", "wiederherstellen",
  ]);
  const REVEAL = words([
    "reveal", "show", "view", "copy", "unhide", "display", "unmask",
    "anzeigen", "einblenden", "kopieren", "zeigen", "ansehen", "aufdecken",
  ]);
  // "eye" only as its own word or icon name (fa-eye, eye-off, EyeIcon), never
  // inside words such as "eyebrow" or "survey".
  const REVEAL_ICON =
    /(?<![\p{L}])eye(?:[-_]?(?:icon|open|off|slash|closed|fill|outline))?(?![\p{L}])|(?<![\p{L}])eye(?=icon|open|off|slash)|visibility|reveal|clipboard|(?<![\p{L}])copy/iu;
  const SIGN_IN_EXACT = /^(?:sign\s*in|log\s*in|login|sign\s*on|anmelden|einloggen|jetzt\s+anmelden|login\s+now)$/iu;
  // Identity providers. Sign-in phrasing only counts with one of these, so
  // "Mit Import fortfahren" or "Log in with your email below" stay ordinary.
  const IDENTITY_PROVIDERS =
    "(?:google|apple|microsoft|github|gitlab|bitbucket|facebook|linkedin|twitter|x|sso|saml|okta|slack|discord|amazon|azure|keycloak|passkeys?|single\\s+sign[\\s-]?on|security\\s+key|e-?mail|id\\s+austria|handy-?signatur)";
  const FEDERATED_SIGN_IN = new RegExp(
    [
      `(?:sign\\s*in|log\\s*in|login|sign\\s*up|register|continue|connect)\\s+(?:with|via|using)\\s+${IDENTITY_PROVIDERS}(?![\\p{L}\\p{N}])`,
      `(?:anmelden|einloggen|registrieren|fortfahren|weiter)\\s+mit\\s+(?:(?:ihrem|deinem|dem|der)\\s+)?${IDENTITY_PROVIDERS}(?![\\p{L}\\p{N}])`,
      `mit\\s+(?:(?:ihrem|deinem|dem|der)\\s+)?${IDENTITY_PROVIDERS}(?:[\\s-]?(?:konto|account|id))?\\s+(?:anmelden|einloggen|fortfahren|registrieren)`,
    ].join("|"),
    "iu",
  );
  const SEARCH_LABEL = words(["search", "suche", "suchen", "filter", "find", "finden", "durchsuchen"]);
  const DISMISS_EXACT = /^(?:reject\s+all|decline\s+all|only\s+necessary|necessary\s+only|use\s+necessary\s+only|essential\s+only|only\s+essential|close|dismiss|alle\s+ablehnen|nur\s+notwendige|nur\s+notwendige\s+cookies|nur\s+erforderliche|nur\s+essenzielle|schließen|×|✕)$/iu;
  const PAGE_LABEL = /^(?:\d{1,4}|next|next\s+page|previous|previous\s+page|prev|first|last|older|newer|weiter|zurück|vor|nächste|nächste\s+seite|vorherige|vorherige\s+seite|erste|letzte|seite\s+\d{1,4}|page\s+\d{1,4}|[‹›«»<>…]|\.\.\.)$/iu;
  const FILE_EXTENSION = /\.(?:csv|tsv|xls|xlsx|json|xml|txt|pdf|zip|gz|ofx|qif|mt940|sta|camt|053|xbrl)$/i;
  const FREE_KEYS = new Set(["Tab", "Escape", "PageUp", "PageDown", "Home", "End"]);
  const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number", "password"]);
  const VALUE_WIDGET_ROLES = new Set([
    "slider", "spinbutton", "listbox", "option", "radio", "radiogroup", "combobox", "menuitemradio",
    "menuitemcheckbox", "checkbox", "switch",
  ]);
  const VALUE_INPUT_TYPES = new Set(["range", "number", "radio", "checkbox", "date", "time", "datetime-local", "month", "week", "color"]);
  const NAVIGATION_AREAS = ["nav", "menu", "menubar", "tree", "tablist"];

  // Risky addresses are judged by the address only.
  const RISKY_SIGN_OUT = /^(?:log-?out|sign-?out|sign_out|log_out|abmelden|unsubscribe|abbestellen|austragen|newsletter-abmelden)$/i;
  const ACTION_SEGMENTS = new Map([
    ["delete", "destructive"], ["remove", "destructive"], ["cancel", "destructive"], ["revoke", "credential"],
    ["unlink", "destructive"], ["löschen", "destructive"], ["loeschen", "destructive"],
    ["stornieren", "destructive"], ["kündigen", "destructive"], ["kuendigen", "destructive"],
    ["confirm", "permission"], ["approve", "permission"], ["accept", "permission"], ["join", "permission"],
    ["verify", "permission"], ["activate", "permission"], ["reset", "credential"], ["forward", "message"],
  ]);
  const TOKEN_LINK_SEGMENTS = new Map([
    ["invite", "permission"], ["invites", "permission"], ["invitation", "permission"],
    ["invitations", "permission"], ["einladung", "permission"], ["magic", "credential"],
    ["magic-link", "credential"], ["magiclink", "credential"], ["reset", "credential"],
    ["reset-password", "credential"], ["password-reset", "credential"], ["passwort-zuruecksetzen", "credential"],
  ]);
  const SEARCH_QUERY_KEYS = new Set(["q", "query", "search", "s", "suche", "term", "keyword", "keywords", "filter", "text"]);

  const CATEGORY_TITLES = Object.freeze({
    purchase: "Purchase or payment",
    transfer: "Money transfer",
    message: "Send a message",
    permission: "Sharing or access change",
    credential: "Key or password change",
    download: "Download or export",
    destructive: "Delete, cancel or sign out",
    may_show_secret: "May show a secret",
    change: "Change something",
  });

  const REFUSALS = Object.freeze({
    reveal_secret: {
      code: "step_refused_secret",
      message: "Revealing or copying a credential is never done by the agent. Stop and tell the user which control shows the value; they can open this page in their own browser.",
    },
    sign_in: {
      code: "step_refused_sign_in",
      message: "Signing in is the user's step. Use request_human_input on the sign-in fields or ask the user to sign in, then continue after they do.",
    },
    upload: {
      code: "step_refused_upload",
      message: "Choosing or uploading files is the user's step. Ask the user to choose the file themselves.",
    },
    sensitive: {
      code: "sensitive_input_blocked",
      message: "Agent typing into password, verification-code, or payment fields is blocked.",
    },
  });

  const lower = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
  const cleanText = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

  function allow(category, reason) {
    return { verdict: "allow", category, reason };
  }
  function ask(category, reason) {
    return { verdict: "ask", category, reason };
  }
  function refuse(category, reason) {
    return { verdict: "refuse", category, reason, code: REFUSALS[category].code };
  }

  function labelOf(target) {
    return cleanText([target.ariaLabel, target.text, target.title, target.value].filter(Boolean).join(" "));
  }

  /** Visible text and accessible name, for dialogs that show both when they differ. */
  function stepLabels(target) {
    const accessible = cleanText(target.ariaLabel || "");
    const visible = cleanText(target.text || target.value || target.title || "");
    return { accessible, visible, differ: Boolean(accessible && visible && accessible !== visible) };
  }

  function areasOf(target) {
    return lower(target.areas).split(/\s+/).filter(Boolean);
  }

  function isSubmitControl(target) {
    const tag = lower(target.tag);
    const type = lower(target.type);
    const owned = Boolean(cleanText(target.formOwnerIdentity));
    return owned && ((tag === "button" && (type === "submit" || type === "")) ||
      (tag === "input" && (type === "submit" || type === "image")));
  }

  function isButtonLike(target) {
    const tag = lower(target.tag);
    const role = lower(target.role);
    const type = lower(target.type);
    return tag === "button" || role === "button" || (tag === "input" && ["button", "submit", "image", "reset"].includes(type));
  }

  function isEditable(target) {
    const tag = lower(target.tag);
    const role = lower(target.role);
    const type = lower(target.type);
    return target.contentEditable === true ||
      tag === "textarea" ||
      (tag === "input" && TEXT_INPUT_TYPES.has(type)) ||
      ["textbox", "searchbox", "combobox"].includes(role);
  }

  function isValueWidget(target) {
    const tag = lower(target.tag);
    const role = lower(target.role);
    const type = lower(target.type);
    return tag === "select" || VALUE_WIDGET_ROLES.has(role) || (tag === "input" && VALUE_INPUT_TYPES.has(type));
  }

  function siteOf(value) {
    try {
      const parsed = new URL(value);
      return parsed.hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return null;
    }
  }

  function isSearchField(target) {
    const tag = lower(target.tag);
    const role = lower(target.role);
    const type = lower(target.type);
    if (target.contentEditable === true || tag === "textarea") return false;
    if (lower(target.formMethod) === "post") return false;
    if (type === "search" || role === "searchbox") return true;
    if (areasOf(target).includes("search")) return tag === "input" || role === "combobox" || role === "textbox";
    if (!(tag === "input" && ["", "text"].includes(type)) && role !== "combobox") return false;
    return SEARCH_LABEL.test(cleanText([target.ariaLabel, target.placeholder, target.name, target.id, target.title].filter(Boolean).join(" ")));
  }

  // A short form with exactly one password field. Change-password and
  // sign-up forms with a confirmation field have more than one.
  function isSignInForm(target) {
    const passwords = target.formPasswordCount === undefined ? 1 : Number(target.formPasswordCount);
    return target.formHasPassword === true && passwords === 1 && Number(target.formFieldCount || 0) <= 4;
  }

  function isPlainHttpLink(target) {
    if (target.linkSelf !== true) return false;
    try {
      const protocol = new URL(cleanText(target.href)).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  function credentialish(target, label) {
    return target.credentialContext === true || target.nearMaskedText === true || credentialNoun.test(label);
  }

  /** The named category of a label, or null for a label with no risk words. */
  function categoryOfLabel(label) {
    if (!label) return null;
    if (PURCHASE.test(label)) return "purchase";
    if (TRANSFER.test(label)) return "transfer";
    if (credentialNoun.test(label)) return CREDENTIAL_VERB.test(label) || DESTRUCTIVE.test(label) ? "credential" : "may_show_secret";
    if (DESTRUCTIVE.test(label)) return "destructive";
    if (PERMISSION.test(label)) return "permission";
    if (DOWNLOAD.test(label)) return "download";
    if (MESSAGE.test(label)) return "message";
    return null;
  }

  function riskyLabel(label) {
    return categoryOfLabel(label) !== null || COMMIT.test(label);
  }

  function idLike(segment) {
    return /^\d{1,20}$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^[0-9a-f]{8,}$/i.test(segment) ||
      redaction.looksRandom(segment, 12);
  }

  /** Risky GET addresses; search terms never count. Returns null when ordinary. */
  function classifyAddress(value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const decode = (part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decode(segment).toLowerCase());
    const queryEntries = [];
    for (const pair of parsed.search.replace(/^\?/, "").split("&").filter(Boolean)) {
      const [rawKey, ...rest] = pair.split("=");
      const key = decode(rawKey).toLowerCase();
      if (SEARCH_QUERY_KEYS.has(key)) continue;
      queryEntries.push([key, decode(rest.join("="))]);
    }
    const last = segments[segments.length - 1] || "";
    if (FILE_EXTENSION.test(last) || segments.some((segment) => segment.includes("datev"))) {
      return ask("download", "file address");
    }
    for (const segment of segments) {
      if (RISKY_SIGN_OUT.test(segment) || segment.startsWith("logout") || segment.startsWith("signout")) {
        return ask("destructive", "sign-out or unsubscribe address");
      }
      if (/export|download|herunterladen/.test(segment)) {
        return ask("download", "export address");
      }
    }
    if (queryEntries.some(([key, item]) => /^(?:export|download)$/.test(key) ||
      (key === "format" && /^(?:csv|tsv|xlsx?|json|xml|pdf|zip|ofx|qif)$/i.test(item)))) {
      return ask("download", "export address");
    }
    const hasIdQuery = queryEntries.some(([key, item]) => /(?:^|_)(?:id|token|code|key|uid|ref)$/.test(key) && item && idLike(item));
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const tokenCategory = TOKEN_LINK_SEGMENTS.get(segment);
      const next = segments[index + 1];
      if (tokenCategory && ((next && redaction.looksRandom(next, 16)) ||
        queryEntries.some(([key, item]) => /token|code|key|t$/.test(key) && redaction.looksRandom(item, 16)))) {
        return ask(tokenCategory, "link with a one-time token");
      }
      const actionCategory = ACTION_SEGMENTS.get(segment);
      if (!actionCategory) continue;
      const previous = segments[index - 1];
      if ((next && idLike(next)) || (previous && idLike(previous)) || hasIdQuery) {
        return ask(actionCategory, "action address");
      }
    }
    return null;
  }

  function isSamePageAnchor(href, pageUrl) {
    if (!pageUrl) return false;
    try {
      const target = new URL(href);
      const page = new URL(pageUrl);
      return Boolean(target.hash !== "" || href.endsWith("#")) &&
        target.origin === page.origin && target.pathname === page.pathname && target.search === page.search;
    } catch {
      return false;
    }
  }

  function classifyActivation(target, ctx) {
    const tag = lower(target.tag);
    const role = lower(target.role);
    const type = lower(target.type);
    const label = labelOf(target);
    const areas = areasOf(target);
    const inDialog = areas.includes("dialog");

    if (tag === "input" && type === "file") return refuse("upload", "file chooser");

    // A whole row's label is the text of every control in it, so a row is
    // never a reveal control because a button inside it says "Anzeigen". A
    // row in a credential context still asks as "may show a secret" below.
    const rowTarget = ["tr", "li"].includes(tag) || ["row", "listitem"].includes(role);
    const revealLike = !rowTarget && (REVEAL.test(label) || REVEAL_ICON.test(cleanText(target.iconHint)));
    const plainHttpLink = isPlainHttpLink(target);
    // A link to another page ("View invoice", "View documentation") is a
    // reveal only when its own label names a credential; otherwise the page
    // it opens is checked on its own.
    if (revealLike && (plainHttpLink ? credentialNoun.test(label) : credentialish(target, label))) {
      return refuse("reveal_secret", "reveal or copy control in a credential context");
    }

    // Clicking into a field only focuses it; typing is classified on its own.
    if (isEditable(target) && !FEDERATED_SIGN_IN.test(label)) return allow("focus", "focus a field");

    if (FEDERATED_SIGN_IN.test(label)) return refuse("sign_in", "sign-in with another account");
    if (isSubmitControl(target) && isSignInForm(target)) return refuse("sign_in", "sign-in form submit");
    // A bare "Log in" button only signs in inside a form with a password
    // field. A header button or link that opens the sign-in page stays free
    // of this refusal, so the agent can reach the page and hand it over.
    if (!plainHttpLink && isButtonLike(target) && SIGN_IN_EXACT.test(label) && target.formHasPassword === true) {
      return refuse("sign_in", "sign-in button");
    }

    const href = cleanText(target.href);
    if (href) {
      const risky = classifyAddress(href);
      if (risky) return risky;
      let protocol = "";
      try {
        protocol = new URL(href).protocol;
      } catch {
        protocol = "";
      }
      if (target.download === true || (protocol === "http:" || protocol === "https:") && FILE_EXTENSION.test(new URL(href).pathname)) {
        return ask("download", "download link");
      }
      // A link inside a credential row or dialog may open the secret; a link
      // elsewhere under a credential heading is ordinary navigation.
      const credentialEntry = target.credentialContext === true && (target.row === true || inDialog);
      const plain = target.linkSelf === true &&
        (protocol === "http:" || protocol === "https:") &&
        !isSamePageAnchor(href, ctx && ctx.pageUrl) &&
        !credentialEntry &&
        !["button", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "checkbox", "radio", "tab", "option"].includes(role);
      if (plain) {
        // Words only add risk: a link named "Delete", "Pay now" or "Abmelden"
        // can run a script or a data-method request whatever its address.
        const linkCategory = categoryOfLabel(label);
        if (linkCategory && linkCategory !== "may_show_secret") return ask(linkCategory, "labelled link");
        return allow("navigation", "plain link");
      }
    }

    // A submit control is checked before the disclosure rules: a submit
    // button that also opens a menu still submits its form.
    if (isSubmitControl(target)) {
      return ask(categoryOfLabel(`${label} ${cleanText(target.formSubmitLabels)}`) || "change", "form submit");
    }

    const namedCategory = categoryOfLabel(label);
    const editable = isEditable(target);
    if (!editable && !isValueWidget(target)) {
      if ((role === "tab" || tag === "summary" || target.menuOpener === true) && !riskyLabel(label) && !inDialog) {
        return allow("disclosure", "tab, details or menu opener");
      }
      const inNavigationArea = areas.some((area) => NAVIGATION_AREAS.includes(area)) || areas.includes("pagination");
      if (inNavigationArea && !inDialog && PAGE_LABEL.test(label)) {
        return allow("navigation", "page number or next/previous");
      }
      const navigationItem = ["menuitem", "treeitem", "tab"].includes(role) || areas.some((area) => NAVIGATION_AREAS.includes(area));
      if (navigationItem && label && !riskyLabel(label) && !inDialog && target.credentialContext !== true) {
        return allow("navigation", "menu, tree, tab or navigation item");
      }
      if (!cleanText(target.formOwnerIdentity) && DISMISS_EXACT.test(label)) {
        return allow("dismiss", "privacy-preserving dismissal");
      }
    }

    // A row's words come from the controls inside it; in a credential
    // context the row itself may open the secret.
    if (rowTarget && credentialish(target, label)) return ask("may_show_secret", "row in a credential context");
    if (namedCategory) return ask(namedCategory, "labelled control");
    if (credentialish(target, label)) return ask("may_show_secret", "entry in a credential context");
    return ask("change", "control");
  }

  function classifyTyping(target, ctx) {
    const tag = lower(target.tag);
    const type = lower(target.type);
    if (tag === "input" && type === "file") return refuse("upload", "file chooser");
    if (ctx && ctx.sensitive === true) return refuse("sensitive", "sensitive field");
    const autocomplete = lower(target.autocomplete);
    if (target.formHasPassword === true && type !== "password") {
      // Only the account identifier of a form with a password field: an email
      // field, a field marked as the username, or the text field right before
      // the password. Other fields of a sign-up form stay ordinary.
      const identifier = type === "email" ||
        /(?:^|\s)(?:username|email|webauthn)(?:\s|$)/.test(autocomplete) ||
        target.signInIdentifier === true;
      if (identifier) return refuse("sign_in", "sign-in identifier field");
    } else if (/(?:^|\s)(?:username|webauthn)(?:\s|$)/.test(autocomplete)) {
      // Email-first sign-in shows the username field before any password field.
      return refuse("sign_in", "sign-in identifier field");
    }
    if (isSearchField(target)) return allow("search", "search field");
    const labels = cleanText(`${cleanText(target.formSubmitLabels)} ${cleanText(target.formActionText)}`);
    if ((target.contentEditable === true || tag === "textarea") && MESSAGE.test(labels)) return ask("message", "message field");
    return ask("change", "field");
  }

  function classifySubmit(target, ctx) {
    if (ctx && ctx.sensitive === true) return refuse("sensitive", "sensitive field");
    if (isSignInForm(target)) return refuse("sign_in", "sign-in form submit");
    const labels = cleanText(`${cleanText(target.formSubmitLabels)} ${cleanText(target.formActionText)}`);
    const owned = Boolean(cleanText(target.formOwnerIdentity));
    if (isSearchField(target) && !categoryOfLabel(labels)) {
      if (!owned) return allow("search", "search without a form");
      const actionSite = cleanText(target.formActionUrl) ? siteOf(target.formActionUrl) : null;
      const pageSite = ctx && ctx.pageUrl ? siteOf(ctx.pageUrl) : null;
      if (lower(target.formMethod || "get") === "get" && (!cleanText(target.formActionUrl) || (actionSite && actionSite === pageSite))) {
        return allow("search", "same-site GET search");
      }
    }
    const named = categoryOfLabel(labels);
    if (named) return ask(named, "form submit");
    const tag = lower(target.tag);
    if (!owned && (target.contentEditable === true || tag === "textarea" || lower(target.role) === "textbox")) {
      return ask("message", "Enter in a composer");
    }
    return ask("change", "form submit");
  }

  function classifyPress(target, ctx) {
    const key = ctx && typeof ctx.key === "string" ? ctx.key : "";
    if (FREE_KEYS.has(key)) return allow("keyboard", "navigation key");
    if (ARROW_KEYS.has(key)) {
      return isValueWidget(target) ? ask("change", "arrow key on a value control") : allow("keyboard", "arrow key");
    }
    const editable = isEditable(target);
    if (key === "Backspace" || key === "Delete") {
      // Off a field these keys delete the selected mail, file or row.
      return editable ? classifyTyping(target, ctx) : ask("destructive", "delete key on a selection");
    }
    if (key === "Enter") return editable ? classifySubmit(target, ctx) : classifyActivation(target, ctx);
    if (key === " ") return editable ? classifyTyping(target, ctx) : classifyActivation(target, ctx);
    return ask("change", "key");
  }

  function classifyStep(op, target, ctx) {
    const safeTarget = target && typeof target === "object" ? target : {};
    const context = ctx && typeof ctx === "object" ? ctx : {};
    switch (op) {
      case "navigate": {
        const risky = classifyAddress(typeof context.url === "string" ? context.url : "");
        return risky || allow("navigation", "address");
      }
      case "click":
        return classifyActivation(safeTarget, context);
      case "type":
        return classifyTyping(safeTarget, context);
      case "submit":
        return classifySubmit(safeTarget, context);
      case "press":
        return classifyPress(safeTarget, context);
      default:
        return ask("change", "unknown step");
    }
  }

  function categoryTitle(category) {
    return CATEGORY_TITLES[category] || null;
  }

  function refusalFor(category) {
    return REFUSALS[category] || null;
  }

  return Object.freeze({
    CATEGORY_TITLES,
    classifyStep,
    classifyAddress,
    categoryTitle,
    refusalFor,
    stepLabels,
    isEditable,
    isSearchField,
  });
});
