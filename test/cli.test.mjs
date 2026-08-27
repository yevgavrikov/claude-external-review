// The CLI reads your API key and syncs your source, so its argument handling
// and its secret-exclusion list are worth pinning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// --- content scanning ------------------------------------------------------
// Filename exclusion cannot see a key pasted into an ordinary source file, and
// that is the commoner case by far.

test('scan finds credentials inside a normal source file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-scan-'));
  // ASSEMBLED AT RUNTIME so the literals never appear in this file.
  //
  // The first version of this test hardcoded them, and GitHub's own push
  // protection rejected the commit - a secret scanner's test fixtures look
  // exactly like secrets, because that is their job. Allowlisting the "secret"
  // would have been the wrong fix: it teaches the repo to ignore that class,
  // and the next one might be real.
  const stripe = ['sk', 'live', '51H8xQ2eZvKYlo2Cabcdefghijklmnop'].join('_');
  const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
  writeFileSync(join(dir, 'config.js'), [
    `const S = "${stripe}";`,
    `const A = "${aws}";`,
    'const c = "postgres://admin:hunter2@db.internal:5432/prod";',
  ].join('\n'));
  const out = run(['scan', '--in', dir]);
  assert.match(out, /3 possible secret/);
  assert.match(out, /Stripe live key/);
  assert.match(out, /AWS access key id/);
  assert.match(out, /connection string with password/);
});

test('scan does not flag config that is public by design', () => {
  // Firebase client config is an identifier, not a credential. Flagging what
  // every mobile repo commits teaches people to ignore the scanner, which
  // costs more than the warning is worth.
  const dir = mkdtempSync(join(tmpdir(), 'er-scan-'));
  writeFileSync(join(dir, 'firebase_options.dart'),
    'apiKey: "AIzaSyAhGmmMRLrt19Jl9AwpCWo1c41k0tAkNyQ",');
  assert.match(run(['scan', '--in', dir]), /no high-signal secrets/);
});

test('a bare private-key HEADER is a parser, not a key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-scan-'));
  writeFileSync(join(dir, 'pem.js'),
    "pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/\\s+/g, '');");
  assert.match(run(['scan', '--in', dir]), /no high-signal secrets/);
});

test('a real private-key block IS flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-scan-'));
  writeFileSync(join(dir, 'key.txt'),
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ==\n');
  assert.match(run(['scan', '--in', dir]), /private key block/);
});

test('a clean scan does not claim the tree is clean', () => {
  // Overclaiming here is worse than not scanning: it converts "I checked" into
  // "it is safe", which is not what a pattern matcher can tell you.
  const dir = mkdtempSync(join(tmpdir(), 'er-scan-'));
  writeFileSync(join(dir, 'a.js'), 'export const x = 1;');
  assert.match(run(['scan', '--in', dir]), /NOT a clean bill of health/);
});

test('sync refuses when the scan finds something', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-scan-'));
  // Assembled, like the fixture above: a scanner's test data is scanner bait.
  writeFileSync(join(dir, 'c.js'), `const A = "${'AKIA' + 'IOSFODNN7EXAMPLE'}";`);
  const out = run(['sync', '--from', dir, '--to', 'nobody@nowhere:/tmp/x']);
  assert.match(out, /refusing to sync/);
});

// --- install-skill ---------------------------------------------------------
// A command rather than a documented `cp`, because the source path differs
// between a global install, a local one and a git clone - and the README
// originally printed the LOCAL path beside the GLOBAL install instruction,
// which fails on the very first thing a new user does.

test('install-skill places the skill and refuses to clobber it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-skill-'));
  const first = execFileSync('node', [BIN, 'install-skill'],
    { encoding: 'utf8', cwd: dir, env: { ...process.env, NO_COLOR: '1' } });
  assert.match(first, /installed →/);
  assert.ok(readFileSync(join(dir, '.claude/skills/external-review/SKILL.md'), 'utf8')
    .includes('external-review'));

  let blocked = '';
  try {
    execFileSync('node', [BIN, 'install-skill'], { cwd: dir, stdio: 'pipe' });
  } catch (e) { blocked = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  assert.match(blocked, /already exists/,
    'a second run must not silently overwrite a customised skill');
});

test('help lists install-skill, since it is the first thing anyone runs', () => {
  assert.match(run([]), /install-skill/);
});

// ------------------------------------------------------------- providers
//
// A second provider is where this tool stops being a thin OpenRouter wrapper,
// and every one of these pins something that would otherwise fail quietly: a
// key inlined into a config file, a merge that eats somebody's working config,
// or a command that prints an empty table where it should print "I cannot
// answer that".

test('an unknown provider names the ones that exist', () => {
  const out = run(['quota', '--provider', 'nope']);
  assert.match(out, /unknown provider "nope"/);
  assert.match(out, /openrouter/);
  assert.match(out, /nvidia/);
});

test('EXTERNAL_REVIEW_PROVIDER selects the provider without a flag', () => {
  const out = run(['doctor'], { EXTERNAL_REVIEW_PROVIDER: 'nvidia', NVIDIA_API_KEY: '' });
  assert.match(out, /NVIDIA API Catalog/);
});

test('the runner config references the key by env, never inlines it', () => {
  const out = run(['runner-config', '--provider', 'nvidia'],
    { NVIDIA_API_KEY: 'nvapi-SECRET-VALUE-DO-NOT-PRINT' });
  assert.match(out, /\{env:NVIDIA_API_KEY\}/);
  assert.doesNotMatch(out, /SECRET-VALUE/,
    'a config file gets committed and pasted into issues; a key in it is a key disclosed');
});

test('runner-config --write merges instead of clobbering an existing config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er-cfg-'));
  writeFileSync(join(dir, 'opencode.json'),
    JSON.stringify({ theme: 'mine', provider: { other: { keep: true } } }));
  execFileSync('node', [BIN, 'runner-config', '--provider', 'nvidia', '--write'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const after = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
  assert.equal(after.theme, 'mine', 'unrelated settings must survive');
  assert.equal(after.provider.other.keep, true, 'other providers must survive');
  assert.equal(after.provider.nvidia.options.apiKey, '{env:NVIDIA_API_KEY}');
});

test('runner-config says OpenRouter needs no config rather than writing a redundant block', () => {
  assert.match(run(['runner-config']), /needs no runner config/);
});

test('quota for a provider with no quota endpoint refuses to imply a clean bill', () => {
  const out = run(['quota', '--provider', 'nvidia']);
  assert.match(out, /no quota API/);
  assert.match(out, /POOL, not a daily allowance/,
    'the pool-vs-daily-reset difference is the one that ruins a review plan');
  assert.doesNotMatch(out, /spent today/,
    'printing zeroes would read as "you have spent nothing", a claim it cannot make');
});

test('providers surfaces the two NVIDIA clauses that have no OpenRouter equivalent', () => {
  const out = run(['providers', 'any/model', '--provider', 'nvidia']);
  assert.match(out, /NOT TO SUBMIT CONFIDENTIAL DATA/);
  assert.match(out, /TRIAL USE ONLY, NOT PRODUCTION/);
  assert.match(out, /believe the contract/,
    'the marketing pages and the ToS disagree; the tool must say which one binds');
});

test('a model id keeps working with or without the runner prefix', () => {
  // Both spellings must reach the same place. The failure this prevents is a
  // silent `nvidia/nvidia/...` that the runner rejects as an unknown model.
  const withPrefix = run(['run', '--prompt', '/nonexistent', '--model', 'nvidia/x',
    '--provider', 'nvidia']);
  const without = run(['run', '--prompt', '/nonexistent', '--model', 'x',
    '--provider', 'nvidia']);
  for (const out of [withPrefix, without]) {
    assert.match(out, /no such prompt file/, 'both spellings must get past model parsing');
  }
});
