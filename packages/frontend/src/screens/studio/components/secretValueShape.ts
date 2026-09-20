/**
 * The one shape check the card makes before a value is saved.
 *
 * A token or key never has whitespace inside it, so a value with a space, a
 * tab or a line break in it is words copied around the value (a label, a
 * heading, a sentence from the provider's page) rather than the value. The
 * first real Notion run saved exactly that: forty-three characters of words,
 * no digits. Refusing it here, in the card, saves the round trip in which the
 * agent learns from the provider's 401 that the value was not a token and has
 * to ask again.
 *
 * Only whitespace is checked. Prefixes and lengths differ by provider and
 * change under us; a wrong-but-well-formed value is for the skill's own status
 * check to catch.
 */
export function describeSecretValueProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/\s/.test(trimmed)) {
    return "That has spaces in it, and a token never does. Copy only the value itself, not the words around it.";
  }
  return null;
}
