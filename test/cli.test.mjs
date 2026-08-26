// The CLI reads your API key and syncs your source, so its argument handling
// and its secret-exclusion list are worth pinning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BIN = new URL('../bin/external-review.mjs', import.meta.url).pathname;
const src = readFileSync(BIN, 'utf8');

const run = (args, env = {}) => {
  try {
    return execFileSync('node', [BIN, ...args],
      { encoding: 'utf8', env: { ...process.env, ...env, NO_COLOR: '1' } });
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

test('help lists every command it implements', () => {
  const out = run([]);
  for (const cmd of ['doctor', 'quota', 'models', 'providers', 'sync', 'run']) {
    assert.match(out, new RegExp(`\\b${cmd}\\b`), `help omits ${cmd}`);
  }
});

test('an unknown command exits non-zero rather than doing something', () => {
  let code = 0;
  try {
    execFileSync('node', [BIN, 'destroy-everything'], { stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.equal(code, 1);
});

test('sync refuses without a destination', () => {
  assert.match(run(['sync']), /usage: external-review sync/);
});

test('run refuses without a prompt or model', () => {
  assert.match(run(['run']), /usage: external-review run/);
  assert.match(run(['run', '--prompt', '/nonexistent']), /usage|no such/);
});

test('a missing key is an error, never a silent unauthenticated call', () => {
  // HOME is redirected so the opencode auth store cannot supply one either.
  const out = run(['quota'], { OPENROUTER_API_KEY: '', HOME: '/nonexistent' });
  assert.match(out, /no API key/);
});

test('the exclusion list covers the credential shapes people actually have', () => {
  // Not exhaustive by design - the docs say to extend it per repo - but these
  // are the ones whose absence would be a bug rather than a gap.
  for (const pat of ['.env', '*.pem', '*.key', '*.jks', '*.p12', 'id_rsa*',
                     'service-account*.json', '.git/']) {
    assert.ok(src.includes(`'${pat}'`), `exclusion list is missing ${pat}`);
  }
});

test('sync VERIFIES the exclusions rather than trusting rsync exit code', () => {
  // The whole point of the command: an exclusion that silently failed to match
  // is the risk, and rsync exits 0 either way.
  assert.match(src, /LEAKED:/);
  assert.match(src, /leaked\.length/);
});

test('the key is never written to stdout in full', () => {
  // doctor prints a fingerprint; nothing may print the whole thing.
  assert.ok(!/console\.log\([^)]*\bkey\b\s*\)/.test(src),
    'a bare key is logged somewhere');
  assert.match(src, /key\.slice\(0, 8\)/, 'doctor should print a fingerprint');
});

// --- data-policy disclosure ------------------------------------------------
// Researched 2026-08-26: OpenRouter will not route to free endpoints at all
// unless the account has opted into "may train on inputs" and "may publish
// prompts". So a working free model implies those are on, and the source being
// reviewed may be trained on. That is the single most important thing this tool
// can tell someone, and it must be said where the choice is made.

test('the free-endpoint data-policy warning exists and names both toggles', () => {
  assert.match(src, /may train on inputs/);
  assert.match(src, /may publish prompts/);
  assert.match(src, /Zero Data Retention|zdr/i,
    'the warning must name the actual remedy, not just the problem');
});

test('the warning is gated on endpoint PRICING, not on the id string', () => {
  // The canonical slug this command takes has no `:free` suffix, so matching on
  // the name missed exactly the models the warning is for.
  assert.match(src, /endpoints\.some\(\(e\) => isFree\(e\)\)/);
});

test('a model with NO published endpoints is handled as an answer', () => {
  // Stealth models list no provider at all. "I could not tell you who runs it"
  // is the most useful thing to say there, not an empty list or a crash.
  assert.match(src, /does not disclose its providers/);
  assert.match(src, /endpoints\.length === 0/);
});

test('quota distinguishes the stealth pool from the :free pool', () => {
  // Nine passes ran in one day because the stealth model draws on a separate,
  // much larger allowance. Conflating the two makes the stop look inexplicable.
  assert.match(src, /free-models-per-day-stealth/);
  assert.match(src, /1000\/day|1000 requests/);
  assert.match(src, /20\/minute|20 requests/);
});
