#!/usr/bin/env node
// external-review — pick a second model, know what it costs you, know where
// your code goes, and run a review with it.
//
// No dependencies on purpose: this reads your API key and syncs your source, so
// the whole thing should be auditable in one sitting.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const OR = 'https://openrouter.ai/api/v1';

// ---------------------------------------------------------------- utilities

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
      g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
      r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

const die = (msg) => { console.error(`${C.r('error')} ${msg}`); process.exit(1); };
const info = (msg) => console.error(C.dim(msg));

/** Read the OpenRouter key from the env or from opencode's auth store. */
function apiKey({ required = true } = {}) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const authFile = join(homedir(), '.local/share/opencode/auth.json');
  if (existsSync(authFile)) {
    try {
      const key = JSON.parse(readFileSync(authFile, 'utf8'))?.openrouter?.key;
      if (key) return key;
    } catch { /* fall through to the error below */ }
  }
  if (!required) return null;
  die('no API key. Set OPENROUTER_API_KEY, or run `opencode auth login`.');
}

async function api(path, { key = apiKey(), ...init } = {}) {
  const res = await fetch(`${OR}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) },
  });
  if (!res.ok) die(`OpenRouter ${path} → HTTP ${res.status}`);
  return res.json();
}

const num = (v) => (v == null ? null : Number(v));
const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(4)}`);

/** Per-million-token price, which is how everyone actually compares models. */
function perM(pricing = {}) {
  const p = num(pricing.prompt);
  const c = num(pricing.completion);
  if (p == null && c == null) return '—';
  const fmt = (x) => (x == null ? '?' : x === 0 ? 'free' : `$${(x * 1e6).toFixed(2)}`);
  return `${fmt(p)} in / ${fmt(c)} out`;
}

const isFree = (m) => num(m?.pricing?.prompt) === 0 && num(m?.pricing?.completion) === 0;

// ------------------------------------------------------------------ doctor

async function cmdDoctor() {
  let bad = 0;
  const check = (ok, label, detail) => {
    console.log(`${ok ? C.g('  ok  ') : C.y(' warn ')} ${label}${detail ? C.dim(`  ${detail}`) : ''}`);
    if (!ok) bad++;
  };

  console.log(C.b('\nexternal-review doctor\n'));

  const key = apiKey({ required: false });
  check(!!key, 'API key found',
    key ? `${key.slice(0, 8)}…${key.slice(-4)}` : 'set OPENROUTER_API_KEY or run `opencode auth login`');

  const runner = findRunner();
  check(!!runner, 'a runner is installed', runner || 'install one: npm i -g opencode-ai');

  for (const tool of ['rsync', 'ssh']) {
    const ok = spawnSync('which', [tool]).status === 0;
    check(ok, `${tool} available`, ok ? '' : 'needed only for the remote-machine workflow');
  }

  if (key) {
    const { data } = await api('/key', { key });
    const tier = data.is_free_tier ? 'free tier' : 'paid';
    check(true, `key reachable (${tier})`, `spent today: ${money(data.usage_daily)}`);
    if (data.is_free_tier) {
      console.log(C.dim(
        '\n  Free tier: OpenRouter caps free-model requests per day (50/day, or\n' +
        '  1000/day once the account has ever purchased 10 credits). A long review\n' +
        '  is many requests. `external-review quota` shows where you stand.'));
    }
  }

  console.log(bad ? C.y('\nSome checks want attention.\n') : C.g('\nReady.\n'));
}

function findRunner() {
  for (const c of [join(homedir(), '.opencode/bin/opencode'), 'opencode']) {
    if (c.startsWith('/') ? existsSync(c) : spawnSync('which', [c]).status === 0) return c;
  }
  return null;
}

// ------------------------------------------------------------------- quota

async function cmdQuota() {
  const { data } = await api('/key');
  console.log(C.b('\nAccount\n'));
  const row = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`);
  row('tier', data.is_free_tier ? C.y('free') : C.g('paid'));
  row('spent today', money(data.usage_daily));
  row('spent this week', money(data.usage_weekly));
  row('spent this month', money(data.usage_monthly));
  row('spent all time', money(data.usage));

  if (data.limit != null) {
    const pct = Math.round((num(data.limit_remaining) / num(data.limit)) * 100);
    const bar = '█'.repeat(Math.max(0, Math.round(pct / 5))).padEnd(20, '░');
    row('credit limit', money(data.limit));
    row('remaining', `${money(data.limit_remaining)}  ${pct > 25 ? C.g(bar) : C.y(bar)} ${pct}%`);
    if (data.limit_reset) row('resets', data.limit_reset);
  } else {
    row('credit limit', C.dim('none set'));
  }

  if (data.is_free_tier) {
    console.log(C.y('\n  Free-model request cap'));
    console.log(C.dim(
      '  :free models      50 requests/day, and 20/minute.\n' +
      '                    1000/day once the account has EVER purchased 10\n' +
      '                    credits — permanent, not a subscription.\n' +
      '  resets            on the UTC day.\n\n' +
      '  The daily counter is ACCOUNT-WIDE across every :free model, so switching\n' +
      '  free models does not get you a fresh budget. It is not exposed by the\n' +
      '  API, which is why it is not shown above.\n\n' +
      '  STEALTH MODELS DRAW ON A SEPARATE POOL. An anonymous/cloaked preview\n' +
      '  model is not a :free model and has its own, much larger allowance —\n' +
      '  which is why a day can run far past 50 requests and then stop abruptly\n' +
      '  when you switch to a genuine :free model. The two errors differ:\n' +
      '    "Rate limit exceeded: free-models-per-day-stealth"  → stealth pool\n' +
      '    "Rate limit exceeded: free-models-per-day"          → the 50/day pool\n\n' +
      '  A whole-subsystem review is 40-150 requests. On the free tier that is\n' +
      '  ONE pass, maybe two. Add credits, or use stealth models, or expect to\n' +
      '  plan a day at a time.'));
  }
  console.log();
}

// ------------------------------------------------------------------ models

async function cmdModels(args) {
  const wantFree = args.includes('--free');
  const wantAll = args.includes('--all');
  const limit = Number(argValue(args, '--limit') ?? (wantAll ? 1e9 : 25));
  const minCtx = Number(argValue(args, '--min-context') ?? 60000);

  const { data } = await api('/models');
  let models = data.filter((m) => (num(m.context_length) ?? 0) >= minCtx);
  if (wantFree) models = models.filter(isFree);

  // A code review means reading a lot and writing a little, so rank by context
  // first — a model that cannot hold the subsystem cannot review it.
  models.sort((a, b) => (num(b.context_length) ?? 0) - (num(a.context_length) ?? 0));

  console.log(C.b(`\n${models.length} model(s) with ≥${(minCtx / 1000) | 0}k context${wantFree ? ', free only' : ''}\n`));
  console.log(C.dim('  context   price / 1M tokens          id'));
  for (const m of models.slice(0, limit)) {
    const ctx = `${Math.round((num(m.context_length) ?? 0) / 1000)}k`.padStart(7);
    const price = perM(m.pricing).padEnd(26);
    console.log(`  ${ctx}   ${isFree(m) ? C.g(price) : price} ${m.id}`);
  }
  if (models.length > limit) console.log(C.dim(`\n  …${models.length - limit} more. --all to list them, --limit N to change.`));
  console.log(C.dim('\n  Next: `external-review providers <id>` to see who serves it and where.\n'));
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// --------------------------------------------------------------- providers

async function cmdProviders(args) {
  const model = args.find((a) => !a.startsWith('-'));
  if (!model) die('usage: external-review providers <model-id>');

  const [{ data: detail }, { data: providers }] = await Promise.all([
    api(`/models/${model}/endpoints`),
    api('/providers'),
  ]);
  const byName = new Map(providers.map((p) => [p.name, p]));

  console.log(C.b(`\n${detail.name || model}\n`));

  const endpoints = detail.endpoints || [];

  // NO ENDPOINTS is an answer, not an error - and the most important one this
  // command can give. Stealth and cloaked models publish no provider at all, so
  // there is nothing to look up: you cannot learn who runs the machine your
  // source is about to be sent to.
  if (endpoints.length === 0) {
    console.log(C.y('  This model does not disclose its providers.\n'));
    console.log(C.dim(
      '  OpenRouter lists no endpoints for it, which is characteristic of a\n' +
      '  STEALTH or CLOAKED model: an unreleased model shipped under an\n' +
      '  anonymous name to gather real-world usage before launch.\n\n' +
      '  So the questions this command exists to answer — who operates it, from\n' +
      '  where, under which policy — have no available answer. What IS known is\n' +
      '  the arrangement: these models are offered free because prompts and\n' +
      '  completions are logged and used to improve them. That is their purpose,\n' +
      '  not a side effect.\n\n' +
      '  They are genuinely good at review work and frequently frontier-class.\n' +
      '  Use one with code you would not mind training a model. For anything\n' +
      '  else, pick a model that names its providers.\n'));
    return;
  }

  console.log(C.dim('  Your prompt is sent to ONE of these, chosen per request.\n'));

  for (const ep of endpoints) {
    const p = byName.get(ep.provider_name) || {};
    const hq = p.headquarters || '?';
    const dcs = Array.isArray(p.datacenters) && p.datacenters.length
      ? p.datacenters.join(', ')
      : C.dim('not published');
    console.log(`  ${C.c(ep.provider_name)}`);
    console.log(`    headquarters  ${hq}`);
    console.log(`    datacenters   ${dcs}`);
    if (p.privacy_policy_url) console.log(`    privacy       ${C.dim(p.privacy_policy_url)}`);
    if (p.terms_of_service_url) console.log(`    terms         ${C.dim(p.terms_of_service_url)}`);
    console.log();
  }

  console.log(C.dim(
    '  These are facts from OpenRouter, not a judgement. Where a provider is\n' +
    '  based and where it runs its hardware may or may not matter for your code —\n' +
    '  that depends on your obligations, not on ours. Read the linked policy.\n\n' +
    '  To pin a single provider, use OpenRouter\'s `provider.order` routing, or\n' +
    '  choose a model with only one endpoint.\n'));

  // Detected from the endpoints' own PRICING, not from the id string: the
  // canonical slug this command takes has no `:free` suffix, so matching on the
  // name missed exactly the models the warning is for.
  const anyFree = endpoints.some((e) => isFree(e));
  if (anyFree) {
    console.log(C.y('  Before you send source to this one'));
    console.log(C.dim(
      '  Free and stealth endpoints are free because of what they may do with\n' +
      '  your data. OpenRouter will not route to them at all unless you have\n' +
      '  enabled, in Settings → Privacy:\n\n' +
      '    "Enable free endpoints that may train on inputs"\n' +
      '    "Enable free endpoints that may publish prompts"\n\n' +
      '  If free models work for you, those are ON, and the code you send may be\n' +
      '  trained on and published. A stealth model is an unreleased model shipped\n' +
      '  anonymously to gather real usage — logging your prompts IS its purpose.\n\n' +
      '  If that is not acceptable for this code, use Zero Data Retention: a\n' +
      '  privacy-settings toggle, a per-key guardrail, or `"zdr": true` per\n' +
      '  request. It blocks storage and training, and it removes most free\n' +
      '  endpoints — which is the trade being made either way.\n'));
  }
}

// -------------------------------------------------------------------- sync

const DEFAULT_EXCLUDES = [
  '.git/', 'node_modules/', 'build/', 'dist/', 'target/', '.venv/', 'venv/',
  '__pycache__/', '.dart_tool/', '.gradle/', 'Pods/',
  // Anything that is or holds a credential. Extend with --exclude.
  '.env', '.env.*', '*.pem', '*.der', '*.key', '*.jks', '*.keystore', '*.p12',
  '*.mobileprovision', 'id_rsa*', '*.crt',
  'secrets.*', '*.secrets.*', 'credentials.*', 'service-account*.json',
];

/** Paths that must NOT exist in the synced copy, verified after the sync. */
function verifyList(extra) {
  return ['.env', '.git', ...extra];
}

function cmdSync(args) {
  const dest = argValue(args, '--to');
  const src = argValue(args, '--from') ?? process.cwd();
  const extra = args.filter((a, i) => args[i - 1] === '--exclude');
  if (!dest) die('usage: external-review sync --to user@host:~/review-dir [--from .] [--exclude PATH]');

  const excludes = [...DEFAULT_EXCLUDES, ...extra].flatMap((e) => ['--exclude', e]);
  info(`syncing ${src} → ${dest}`);
  const r = spawnSync('rsync', ['-az', '--delete', ...excludes, `${src}/`, dest], { stdio: 'inherit' });
  if (r.status !== 0) die('rsync failed');

  // VERIFY, do not assume. An exclusion that silently did not match is the
  // whole risk this command exists to manage.
  const [userHost, remoteDir] = splitDest(dest);
  if (userHost) {
    const checks = verifyList(extra)
      .map((f) => `if [ -e "${f}" ]; then echo "LEAKED: ${f}"; fi`)
      .join('; ');
    const out = spawnSync('ssh', [userHost, `cd ${remoteDir} && { ${checks}; } ; echo VERIFY_DONE`], { encoding: 'utf8' });
    const leaked = (out.stdout || '').split('\n').filter((l) => l.startsWith('LEAKED:'));
    if (leaked.length) {
      console.error(C.r('\nSecrets reached the review copy:'));
      leaked.forEach((l) => console.error(`  ${l}`));
      die('delete the remote copy and re-sync with the right --exclude flags');
    }
    console.log(C.g('\n  verified: no excluded path is present in the copy\n'));
  }
}

function splitDest(dest) {
  const m = /^([^:]+):(.+)$/.exec(dest);
  return m ? [m[1], m[2]] : [null, dest];
}

// --------------------------------------------------------------------- run

function cmdRun(args) {
  const promptFile = argValue(args, '--prompt');
  const model = argValue(args, '--model');
  const cwd = argValue(args, '--in') ?? process.cwd();
  const out = argValue(args, '--out') ?? join(tmpdir(), `review-${Date.now()}.md`);
  if (!promptFile || !model) {
    die('usage: external-review run --prompt FILE --model ID [--in DIR] [--out FILE]');
  }
  if (!existsSync(promptFile)) die(`no such prompt file: ${promptFile}`);

  const runner = findRunner();
  if (!runner) die('no runner found. Install one: npm i -g opencode-ai');

  const prompt = readFileSync(promptFile, 'utf8');
  info(`model   ${model}`);
  info(`scope   ${cwd}`);
  info(`output  ${out}`);

  const child = spawn(runner, ['run', '-m', model, prompt], {
    cwd, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
  child.on('close', (code) => {
    writeFileSync(out, buf);
    console.error(code === 0 ? C.g(`\nwrote ${out}`) : C.y(`\nrunner exited ${code}; partial output in ${out}`));
    process.exit(code ?? 0);
  });
}

// -------------------------------------------------------------------- help

const HELP = `
${C.b('external-review')} — run a code review with a second, independent model.

${C.b('Commands')}
  doctor                     check your setup and say what is missing
  quota                      spend so far, credit limit, and the free-tier cap
  models [--free] [--all]    candidate models, ranked by context window
         [--min-context N] [--limit N]
  providers <model-id>       who actually serves that model, and from where
  sync --to HOST:DIR         copy your source to a review machine, secrets
       [--from DIR] [--exclude PATH]   excluded — then VERIFY they are absent
  run --prompt FILE --model ID [--in DIR] [--out FILE]

${C.b('Typical first run')}
  external-review doctor
  external-review models --free
  external-review providers <the-one-you-liked>
  external-review run --prompt ./review.txt --model <id> --out findings.md

${C.dim('Docs, and the review prompts that actually found bugs:')}
${C.dim('https://github.com/yevgavrikov/claude-external-review')}
`;

// -------------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const run = {
  doctor: cmdDoctor, quota: cmdQuota, models: cmdModels,
  providers: cmdProviders, sync: cmdSync, run: cmdRun,
}[cmd];

if (!run) { console.log(HELP); process.exit(cmd ? 1 : 0); }
await run(rest);
