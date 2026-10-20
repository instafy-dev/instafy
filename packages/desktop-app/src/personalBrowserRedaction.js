"use strict";

/*
 * Personal Browser redaction.
 *
 * Plain script with no imports so the same file can later be embedded in other
 * browser hosts unchanged. In CommonJS it exports its API; elsewhere it sets
 * `globalThis.__instafyBrowserRedaction`.
 *
 * Everything here is a heuristic that only removes information. It never
 * decides that something is safe to show; the caller withholds the page when
 * redaction itself fails.
 */
(function defineBrowserRedaction(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.__instafyBrowserRedaction = api;
  }
})(typeof globalThis === "object" ? globalThis : null, function browserRedactionFactory() {
  const TEXT_MASK = "[redacted secret]";
  const URL_MASK = "REDACTED";

  // Known key and token formats. Kept as sources so the page bridge can test a
  // value inside the page and return only a yes/no answer.
  const KNOWN_SECRET_PATTERN_SOURCES = Object.freeze([
    "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
    "\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}",
    "\\b[rs]k_(?:live|test|prod)_[A-Za-z0-9]{12,}",
    "\\brk_[A-Za-z0-9]{20,}",
    "\\bwhsec_[A-Za-z0-9+/=]{16,}",
    "\\bgh[opsur]_[A-Za-z0-9]{30,}",
    "\\bgithub_pa[t]_[A-Za-z0-9_]{30,}",
    "\\bglpat-[A-Za-z0-9_-]{20,}",
    "\\bxox[a-z]-[A-Za-z0-9-]{10,}",
    "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b",
    "\\bAIza[0-9A-Za-z_-]{30,}",
    "\\bya29\\.[0-9A-Za-z_-]{20,}",
    "\\bnpm_[A-Za-z0-9]{30,}",
    "\\bhf_[A-Za-z0-9]{30,}",
    "\\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}",
    "\\bntn_[A-Za-z0-9]{30,}",
    "\\bsecret_[A-Za-z0-9]{30,}",
    "\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}",
    "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
    "\\bBearer\\s+[A-Za-z0-9._~+/-]{16,}=*",
  ]);

  // Words that make a heading, dialog, label or row a credential context.
  // English nouns must start a word; German nouns may sit inside a compound
  // (Zugangsschlüssel, Zugangsdaten). Bookkeeping compounds such as
  // Buchungsschlüssel or Steuerschlüssel name a code list, not a credential.
  const CREDENTIAL_CONTEXT_SOURCE =
    "(?:(?<![\\p{L}\\p{N}])(?:api[\\s_-]?(?:keys?|tokens?|zugang|zugriff|schl(?:ü|ue)ssel)|access[\\s_-]?(?:keys?|tokens?)|tokens?|secrets?|credentials?|passwords?|passkeys?|private[\\s_-]?keys?|signing[\\s_-]?(?:keys?|secrets?)|webhook[\\s_-]?secrets?|recovery[\\s_-]?codes?|backup[\\s_-]?codes?|client[\\s_-]?secrets?|personal[\\s_-]?access)" +
    "|(?<!(?:buchungs|steuer|kosten|verteil(?:ungs)?|umlage|w(?:ä|ae)hrungs|l(?:ä|ae)nder|sprach|konten|verrechnungs|aufteilungs)[\\s-]?)schl(?:ü|ue)ssel|zugangsdaten|zugangscode|kennw(?:o|ö)rt|passwort|geheimnis|technische[nr]?\\s+benutzer)";

  // Broader words used only to decide whether an unrecognized random-looking
  // value sits near a credential and should be masked.
  const CREDENTIAL_PROXIMITY_SOURCE =
    "(?:" + CREDENTIAL_CONTEXT_SOURCE + "|(?<![\\p{L}\\p{N}])(?:keys?|bearer|auth(?:orization)?|api|signature|sig|client[\\s_-]?id)(?![\\p{L}]))";

  const PLACEHOLDER_SOURCE =
    "(?:example|sample|placeholder|dummy|your[_-]|<[^>]*>|\\$\\{|\\{\\{|x{6,}|X{6,}|\\*{4,}|\\.\\.\\.|…)";

  // Four or more mask characters. A run that ends in a few visible digits,
  // like a card or account number (•••• 4242), is not a masked secret. Page
  // text has no spaces between elements, so the digits may run straight into
  // the next label ("4242View"); a lowercase or digit tail ("4f2a") is a key.
  const MASKED_TEXT_SOURCE =
    "(?<![•●∙·◦*][ \\u00a0]?)(?:[•●∙·◦*][ \\u00a0]?){4,}(?![ \\u00a0]?(?:[•●∙·◦*]|\\d{2,4}(?![\\p{N}a-z_-])))";

  const knownPatterns = KNOWN_SECRET_PATTERN_SOURCES.map((source) => new RegExp(source, "g"));
  const credentialContextPattern = new RegExp(CREDENTIAL_CONTEXT_SOURCE, "iu");
  const credentialProximityPattern = new RegExp(CREDENTIAL_PROXIMITY_SOURCE, "iu");
  const placeholderPattern = new RegExp(PLACEHOLDER_SOURCE, "i");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const longHexPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
  const opaqueCandidatePattern = /[A-Za-z0-9][A-Za-z0-9_\-+/=~]{18,}[A-Za-z0-9=]/g;
  const digitCodePattern = /(?<![\d.,][ \u00a0]?)(?:\d{6,8}|\d{3}[ \u00a0]\d{3}|\d{4}[ \u00a0]\d{4})(?![\d]|[.,]\d)/g;
  // Whole words only, plus the usual compounds, so Postcode, Steuercode or
  // Barcode do not make an ordinary number a code.
  const codeWordPattern =
    /(?<![\p{L}])(?:codes?|kode|otp|passcode|pin|tan|2fa|mfa|(?:best(?:ä|ae)tigungs|sicherheits|verifizierungs|verifikations|zugangs|anmelde|freigabe|authentifizierungs|wiederherstellungs|einmal)code)(?![\p{L}])/iu;
  const NEARBY_CHARACTERS = 120;
  const CODE_NEARBY_CHARACTERS = 32;
  // A credential word this close makes a UUID or long hex value a secret,
  // unless the value is labelled as an id or a commit ("Token id <uuid>").
  const HEX_NEARBY_CHARACTERS = 32;
  const identifierLabelPattern = /(?<![\p{L}])(?:id|ids|nr|no|number|nummer|commit|sha|uuid|ref)\s*[:#=]?\s*$/iu;

  // Values on these query or fragment keys are masked when they look random.
  const sensitiveUrlKeyPattern =
    /(?:token|code|key|secret|sig|auth|pass|pwd|session|sid|state|otp|reset|invite|magic|credential|nonce|ticket|hash|x-amz-)/i;
  // A path segment after one of these is masked when it looks random.
  const sensitivePathActions = new Set([
    "reset", "reset-password", "password-reset", "password", "invite", "invites", "invitation",
    "invitations", "magic", "magic-link", "magiclink", "verify", "verification", "confirm",
    "confirmation", "activate", "activation", "accept", "join", "token", "tokens", "unsubscribe",
    "login", "signin", "sign-in", "auth", "einladung", "bestaetigen", "bestätigen", "passwort",
    "key", "keys", "api-key", "api-keys", "apikeys", "api-tokens", "access-tokens", "secret", "secrets",
    "credential", "credentials",
  ]);

  function shannonEntropy(value) {
    const counts = new Map();
    for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
      const probability = count / value.length;
      entropy -= probability * Math.log2(probability);
    }
    return entropy;
  }

  function isPlaceholder(value) {
    return placeholderPattern.test(value);
  }

  function hasCredentialWord(value) {
    return typeof value === "string" && credentialContextPattern.test(value);
  }

  /** A single opaque value that is long, mixes letters and digits and looks random. */
  function looksRandom(value, minimumLength = 20) {
    if (typeof value !== "string" || value.length < minimumLength || value.length > 4096) return false;
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
    return shannonEntropy(value) >= 3.5;
  }

  function matchesKnownFormat(value) {
    if (typeof value !== "string") return false;
    return knownPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }

  /**
   * Masks secret-looking values in free text.
   *
   * Options:
   * - credentialContext: the page names a credential, so every random-looking
   *   value is masked wherever it sits, UUIDs and long hex values included;
   * - strict: mask every random-looking value, UUID or hex run regardless of
   *   words. Used for control names on a withheld page.
   *
   * `matches` counts masked values that are not obvious placeholders, which
   * is what decides a secret screen. `masked` counts every replacement.
   */
  function redactText(value, options) {
    if (typeof value !== "string" || !value) return { text: typeof value === "string" ? value : "", matches: 0, masked: 0 };
    const credentialContext = Boolean(options && options.credentialContext);
    const strict = Boolean(options && options.strict);
    let text = value;
    let matches = 0;
    let masked = 0;
    const count = (match) => {
      masked += 1;
      if (!isPlaceholder(match)) matches += 1;
    };

    for (const pattern of knownPatterns) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, (match) => {
        count(match);
        return TEXT_MASK;
      });
    }

    text = text.replace(digitCodePattern, (match, offset, whole) => {
      // Only the words before the number: "Code: 123456", not "123456 · Promo code".
      const before = whole.slice(Math.max(0, offset - CODE_NEARBY_CHARACTERS), offset);
      if (!codeWordPattern.test(before)) return match;
      masked += 1;
      matches += 1;
      return TEXT_MASK;
    });

    opaqueCandidatePattern.lastIndex = 0;
    text = text.replace(opaqueCandidatePattern, (match, offset, whole) => {
      const hexLike = uuidPattern.test(match) || longHexPattern.test(match);
      if (!hexLike && !looksRandom(match)) return match;
      if (!strict && !credentialContext) {
        if (hexLike && identifierLabelPattern.test(whole.slice(Math.max(0, offset - 16), offset))) return match;
        const window = hexLike ? HEX_NEARBY_CHARACTERS : NEARBY_CHARACTERS;
        const nearby = whole.slice(Math.max(0, offset - window), offset) + " " +
          whole.slice(offset + match.length, offset + match.length + window);
        if (!credentialProximityPattern.test(nearby)) return match;
      }
      count(match);
      return TEXT_MASK;
    });

    return { text, matches, masked };
  }

  function decodeComponent(value) {
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return value;
    }
  }

  function sensitiveUrlValue(key, rawValue) {
    const value = decodeComponent(rawValue);
    if (!value) return false;
    if (matchesKnownFormat(value)) return true;
    if (!sensitiveUrlKeyPattern.test(decodeComponent(key))) return false;
    return value.length >= 16 && (looksRandom(value, 16) || uuidPattern.test(value) || /^[0-9a-f]{16,}$/i.test(value));
  }

  function redactPairs(value, onMask) {
    return value.replace(/([^&#?=/]+)=([^&#]*)/g, (whole, key, rawValue) => {
      if (!sensitiveUrlValue(key, rawValue)) return whole;
      onMask(decodeComponent(rawValue));
      return `${key}=${URL_MASK}`;
    });
  }

  /**
   * Masks secret-looking parts of an address while keeping it navigable:
   * fragments and ordinary paths stay, query values on sensitive keys are
   * masked only when long and random, and a path segment is masked only after
   * an action word such as reset, invite, magic or verify.
   */
  function redactUrl(value) {
    if (typeof value !== "string" || !value) return { text: typeof value === "string" ? value : "", matches: 0, masked: 0 };
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return redactText(value);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return redactText(value);
    }
    let matches = 0;
    let masked = 0;
    const count = (match) => {
      masked += 1;
      if (!isPlaceholder(match)) matches += 1;
    };
    const segments = parsed.pathname.split("/");
    const path = segments.map((segment, index) => {
      const decoded = decodeComponent(segment);
      const previous = index > 0 ? decodeComponent(segments[index - 1]).toLowerCase() : "";
      if (
        matchesKnownFormat(decoded) ||
        (sensitivePathActions.has(previous) && decoded.length >= 16 &&
          (looksRandom(decoded, 16) || uuidPattern.test(decoded) || /^[0-9a-f]{16,}$/i.test(decoded)))
      ) {
        count(decoded);
        return URL_MASK;
      }
      return segment;
    }).join("/");
    const search = parsed.search ? redactPairs(parsed.search, count) : "";
    let hash = parsed.hash;
    if (hash) {
      hash = hash.includes("=") ? redactPairs(hash, count) : hash;
      const hashText = redactText(hash);
      matches += hashText.matches;
      masked += hashText.masked;
      hash = hashText.text;
    }
    return { text: `${parsed.protocol}//${parsed.host}${path}${search}${hash}`, matches, masked };
  }

  const SECRET_SCREEN_MESSAGE =
    "This page appears to show a credential value, so its text is withheld until a new page loads. " +
    "Do not try to reveal, copy or read the value. Stop here and tell the user in words which control on this page shows it; " +
    "they can open the page in their own browser to see it.";

  /**
   * Builds the model-facing view of one page observation.
   *
   * `signals` are yes/no answers computed inside the page:
   * - credentialContext: a heading, dialog, label or row names a credential;
   * - secretField: a read-only field holds a key-like value;
   * - secretCode: a code block holds a key-like value;
   * - maskedNearReveal: masked text sits next to a reveal or copy control.
   *
   * `withhold` keeps a page withheld that earlier was a secret screen, or on
   * which a credential step ran.
   */
  function redactPageObservation(input) {
    const signals = (input && input.signals) || {};
    const rawTitle = typeof input.title === "string" ? input.title : "";
    const credentialContext = signals.credentialContext === true || hasCredentialWord(rawTitle);
    const url = redactUrl(typeof input.url === "string" ? input.url : "");
    const title = redactText(rawTitle, { credentialContext });
    const text = redactText(typeof input.text === "string" ? input.text : "", { credentialContext });
    const rawNames = Array.isArray(input.names) ? input.names : [];
    let nameMatches = 0;
    let names = rawNames.map((name) => {
      if (typeof name !== "string" || !name) return name;
      const result = redactText(name, { credentialContext });
      nameMatches += result.matches;
      return result.text;
    });
    const matches = url.matches + title.matches + text.matches + nameMatches;
    const secretScreen =
      input.withhold === true ||
      signals.secretField === true ||
      signals.maskedNearReveal === true ||
      (credentialContext && (signals.secretCode === true || matches > 0));
    if (secretScreen) {
      // A control can be named by the value itself, such as a click-to-copy
      // chip. On a withheld page every random-looking run in a name is masked.
      names = rawNames.map((name) => (typeof name === "string" && name ? redactText(name, { strict: true }).text : name));
    }
    return {
      url: url.text,
      title: title.text,
      text: secretScreen ? "" : text.text,
      names,
      secretScreen,
      ...(secretScreen ? { message: SECRET_SCREEN_MESSAGE } : {}),
    };
  }

  /** Masks every string inside a small log payload. */
  function redactLogValue(value, depth) {
    const level = depth || 0;
    if (typeof value === "string") {
      return /^https?:\/\//i.test(value.trim()) ? redactUrl(value.trim()).text : redactUrlsInText(redactText(value).text);
    }
    if (level > 4 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => redactLogValue(item, level + 1));
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = redactLogValue(item, level + 1);
    return result;
  }

  function redactUrlsInText(value) {
    return value.replace(/https?:\/\/[^\s'"<>]+/gi, (match) => redactUrl(match).text);
  }

  return Object.freeze({
    TEXT_MASK,
    URL_MASK,
    KNOWN_SECRET_PATTERN_SOURCES,
    CREDENTIAL_CONTEXT_SOURCE,
    PLACEHOLDER_SOURCE,
    MASKED_TEXT_SOURCE,
    SECRET_SCREEN_MESSAGE,
    hasCredentialWord,
    looksRandom,
    matchesKnownFormat,
    redactText,
    redactUrl,
    redactPageObservation,
    redactLogValue,
  });
});
