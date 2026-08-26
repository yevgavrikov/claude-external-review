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
