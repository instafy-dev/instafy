import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const templateRoot = new URL('../supabase/supabase/templates/', import.meta.url);
const codeTemplates = ['confirmation', 'magic_link', 'reauthentication'];
const linkTemplates = ['invite', 'recovery', 'email_change'];

for (const name of [...codeTemplates, ...linkTemplates]) {
  test(`${name} retains its auth action in the simplified email`, () => {
    const html = readFileSync(new URL(`${name}.html`, templateRoot), 'utf8');
    assert.match(html, new RegExp(`data-instafy-email="${name}"`));
    const placeholders = [...html.matchAll(/{{\s*\.(\w+)\s*}}/g)].map((match) => match[1]);
    if (codeTemplates.includes(name)) {
      assert.ok(placeholders.includes('Token'), 'the code must remain selectable email text');
      assert.match(html, /<p\b[^>]*>{{\s*\.Token\s*}}<\/p>/);
      assert.ok(placeholders.every((value) => value === 'Token'));
      assert.doesNotMatch(html, /<a\b/i, 'code emails must not route users through a browser-bound link');
    } else {
      assert.match(html, /<a\s+href="{{\s*\.ConfirmationURL\s*}}"/);
      assert.ok(placeholders.every((value) => value === 'ConfirmationURL' || (name === 'email_change' && value === 'NewEmail')));
      if (name === 'email_change') assert.ok(placeholders.includes('NewEmail'));
    }
    assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|@import|<link\b/i);
  });
}
