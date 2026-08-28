#!/usr/bin/env node
// external-review — pick a second model, know what it costs you, know where
// your code goes, and run a review with it.
//
// No dependencies on purpose: this reads your API key and syncs your source, so
// the whole thing should be auditable in one sitting.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, copyFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ providers
 *
 * A review provider is: a base URL, a key, and an honest account of what it can
 * and cannot tell you. The second half matters more than the first. OpenRouter
 * publishes who serves a model, from where, and under which policy; NVIDIA's
 * catalog publishes none of that because the answer is always "NVIDIA" - but it
 * has terms that OpenRouter does not, and a tool that hides the difference is
 * worse than no tool.
 *
 * `caps` is deliberately explicit rather than inferred. A command that cannot
 * answer for a provider should SAY SO, not print an empty table that reads like
 * a clean bill of health.
 */
const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    authStoreKey: 'openrouter',
    hint: 'set OPENROUTER_API_KEY, or run `opencode auth login`',
    // Prefix the runner uses: opencode addresses it as openrouter/<model-id>.
    runnerPrefix: 'openrouter/',
    caps: { spend: true, pricing: true, contextLength: true, endpoints: true },
    // Published limits, not measured ones. The per-day figure is the one that
    // ends runs; it is account-wide across every :free model, so switching
    // free models buys nothing.
    limits: {
      perDay: 50, perMinute: 20, resets: 'utc-day',
      note: '1000/day once the account has EVER purchased 10 credits (permanent). '
          + 'Stealth/cloaked models draw on a SEPARATE, much larger pool - when one '
          + 'is listed, it is the only way to get a long day out of a free account.',
    },
  },
  google: {
    label: 'Google AI Studio (Gemini)',
    // Google publishes an OpenAI-COMPATIBLE surface alongside its native API.
    // Point at this one, not generativelanguage's native path - the native
    // shape is not /chat/completions and the runner cannot speak it.
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    authStoreKey: 'google',
    hint: 'set GEMINI_API_KEY (aistudio.google.com/apikey, no card needed)',
    runnerPrefix: 'google/',
    // The OpenAI-compatible surface serves /models. Everything else - spend,
    // pricing, per-endpoint metadata - lives only in the native API and the
    // console, so this tool cannot show it.
    caps: { spend: false, pricing: false, contextLength: false, endpoints: false },
    // DELIBERATELY UNQUANTIFIED. Google's free-tier limits differ per MODEL and
    // have changed repeatedly; every figure this file could carry would be a
    // secondary source going stale. That is the exact mistake the NVIDIA entry
    // below records having made. `quota` says where the real number lives.
    limits: {
      perDay: null, perMinute: null, resets: 'per-model',
      note: 'Free tier limits are PER MODEL and are not published in a form '
          + 'this tool can read - a flash model and a pro model on the same key '
          + 'have very different ceilings, and both have moved. Read yours at '
          + 'aistudio.google.com, and treat a 429 as the real limit rather than '
          + 'anything quoted here. Rate-shaped like NVIDIA rather than '
          + 'daily-capped like OpenRouter free, so a killed pass is cheap to '
          + 'repeat.',
    },
  },
  nvidia: {
    label: 'NVIDIA API Catalog (build.nvidia.com)',
    base: 'https://integrate.api.nvidia.com/v1',
    env: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
    authStoreKey: 'nvidia',
    hint: 'set NVIDIA_API_KEY (get one at build.nvidia.com, no card needed)',
    runnerPrefix: 'nvidia/',
    // An OpenAI-compatible /models listing and nothing else: no pricing, no
    // context length, no per-endpoint metadata, no spend endpoint.
    caps: { spend: false, pricing: false, contextLength: false, endpoints: false },
    // CORRECTED after a user checked their own account and could not find the
    // credit balance this tool was quoting. NVIDIA removed the credit cap; the
    // free tier is now unlimited requests governed by rate alone. The old
    // "1,000 credits" figure is still all over the web and was wrong to assert
    // from a secondary source - a number nobody can verify in their own console
    // is exactly the kind of claim this tool exists to stop making.
    limits: {
      perDay: null, perMinute: 40, resets: 'rate-only',
      note: 'PUBLISHED: no credit cap, no daily cap, 40 req/min. MEASURED on '
          + 'two independent keys: /v1/models returns 200 while a SINGLE COLD '
          + 'request to chat-completions can return 429 in under a third of a '
          + 'second, with no retry-after and no ratelimit-* headers - so the '
          + 'published rate is not what a cold request meets, and pacing does '
          + 'not help. Responses also differ PER MODEL (429 / 404 / 410 / no '
          + 'response), so the catalog listing is not a list of servable '
          + 'models. Probe one model with one curl before committing a pass.',
    },
  },
};

/* Providers you add yourself, without forking this file.
 *
 * ~/.config/external-review/providers.json, merged over the built-ins. Anything
 * speaking the OpenAI chat-completions shape works, which is most things now:
 *
 *   {
 *     "groq":   { "base": "https://api.groq.com/openai/v1", "env": ["GROQ_API_KEY"] },
 *     "ollama": { "base": "http://localhost:11434/v1",      "env": ["OLLAMA_KEY"] }
 *   }
 *
 * CAPABILITIES DEFAULT TO FALSE, deliberately. A provider this tool has never
 * seen gets treated as one that publishes nothing: `quota` says it cannot
 * answer, `models` says it cannot rank by context. The alternative - assuming a
 * new endpoint speaks OpenRouter's metadata dialect - would print an empty
 * table that reads like a clean bill of health, which is the failure this whole
 * tool is built to avoid. Opt in per capability once you have checked.
 */
const CUSTOM_PROVIDERS_FILE = join(homedir(), '.config/external-review/providers.json');

function loadCustomProviders() {
  if (!existsSync(CUSTOM_PROVIDERS_FILE)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'));
  } catch (e) {
    // Never fall back to "no custom providers" on a parse error: you would run
    // against a DIFFERENT endpoint than the one you thought you configured.
    die(`${CUSTOM_PROVIDERS_FILE} is not valid JSON (${e.message})`);
  }
  const out = {};
  for (const [id, cfg] of Object.entries(raw)) {
    if (!cfg?.base || !Array.isArray(cfg.env) || !cfg.env.length) {
      die(`provider "${id}" in ${CUSTOM_PROVIDERS_FILE} needs at least "base" and a non-empty "env" array`);
    }
    if (!/^https?:\/\//.test(cfg.base)) die(`provider "${id}": "base" must be an http(s) URL`);
    out[id] = {
      label: cfg.label || id,
      base: cfg.base.replace(/\/$/, ''),
      env: cfg.env,
      authStoreKey: cfg.authStoreKey || id,
      hint: cfg.hint || `set ${cfg.env[0]}`,
      runnerPrefix: cfg.runnerPrefix ?? `${id}/`,
      caps: { spend: false, pricing: false, contextLength: false, endpoints: false, ...(cfg.caps || {}) },
      limits: cfg.limits ?? { perDay: null, perMinute: null, resets: 'unknown' },
      custom: true,
    };
  }
  return out;
}

function allProviders() {
  // User config wins, so a built-in whose base URL moved can be corrected
  // locally without waiting for a release.
  return { ...PROVIDERS, ...loadCustomProviders() };
}

function resolveProvider(args = []) {
  const known = allProviders();
  const id = argValue(args, '--provider')
    ?? process.env.EXTERNAL_REVIEW_PROVIDER
    ?? 'openrouter';
  const p = known[id];
  if (!p) {
    die(`unknown provider "${id}". Known: ${Object.keys(known).join(', ')}\n` +
        `  Add your own in ${CUSTOM_PROVIDERS_FILE} — see \`external-review providers\`.`);
  }
  return { id, ...p };
}

// ---------------------------------------------------------------- utilities

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
      g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
      r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

const die = (msg) => { console.error(`${C.r('error')} ${msg}`); process.exit(1); };
const info = (msg) => console.error(C.dim(msg));

/** Read a provider's key from the env, or from opencode's auth store. */
function apiKey(provider, { required = true } = {}) {
  for (const name of provider.env) if (process.env[name]) return process.env[name];
  const authFile = join(homedir(), '.local/share/opencode/auth.json');
  if (existsSync(authFile)) {
    try {
      const key = JSON.parse(readFileSync(authFile, 'utf8'))?.[provider.authStoreKey]?.key;
      if (key) return key;
    } catch { /* fall through to the error below */ }
  }
  if (!required) return null;
  die(`no API key for ${provider.label}. ${provider.hint}.`);
}

async function api(provider, path, { key, ...init } = {}) {
  const res = await fetch(`${provider.base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key ?? apiKey(provider)}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) die(`${provider.label} ${path} → HTTP ${res.status}`);
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

async function cmdDoctor(args = []) {
  const provider = resolveProvider(args);
  let bad = 0;
  const check = (ok, label, detail) => {
    console.log(`${ok ? C.g('  ok  ') : C.y(' warn ')} ${label}${detail ? C.dim(`  ${detail}`) : ''}`);
    if (!ok) bad++;
  };

  console.log(C.b(`\nexternal-review doctor  ${C.dim(provider.label)}\n`));

  const key = apiKey(provider, { required: false });
  check(!!key, 'API key found',
    key ? `${key.slice(0, 8)}…${key.slice(-4)}` : provider.hint);

  const runner = findRunner();
  check(!!runner, 'a runner is installed', runner || 'install one: npm i -g opencode-ai');

  // INSTALLED IS NOT CONFIGURED, and conflating them is the failure this whole
  // command exists to prevent. opencode knows OpenRouter natively and nothing
  // else; without a provider block it accepts the model id, sends no auth
  // header, and the run dies with `Unauthorized: Header of type authorization
  // was missing` — AFTER the snapshot, the prompt and the wait. A doctor that
  // says "Ready" here has told you the key works and let you believe the run
  // will.
  if (runner) {
    const knows = runnerKnowsProvider(process.cwd(), provider.id);
    check(knows, 'runner is configured for this provider',
      knows
        ? (provider.id === 'openrouter' ? 'native to opencode' : 'declared in opencode.json')
        : 'NOT declared — the run will 401 even though the key above works');
    if (!knows) {
      console.log(C.dim(
        `\n  Fix, then restart the runner (it does not reload providers while up):\n` +
        `    external-review runner-config --provider ${provider.id} --write\n` +
        `    export ${provider.env[0]}=…\n`));
    }
  }

  for (const tool of ['rsync', 'ssh']) {
    const ok = spawnSync('which', [tool]).status === 0;
    check(ok, `${tool} available`, ok ? '' : 'needed only for the remote-machine workflow');
  }

  if (key && provider.caps.spend) {
    const { data } = await api(provider, '/key', { key });
    const tier = data.is_free_tier ? 'free tier' : 'paid';
    check(true, `key reachable (${tier})`, `spent today: ${money(data.usage_daily)}`);
    if (data.is_free_tier) {
      console.log(C.dim(
        '\n  Free tier: OpenRouter caps free-model requests per day (50/day, or\n' +
        '  1000/day once the account has ever purchased 10 credits). A long review\n' +
        '  is many requests. `external-review quota` shows where you stand.'));
    }
  } else if (key) {
    // No spend endpoint: prove the key works the only way left, by listing
    // models. "The key is set" is not the same claim as "the key works", and
    // a doctor that conflates them is how you find out mid-review.
    const { data } = await api(provider, '/models', { key });
    check(Array.isArray(data), 'key reachable', `${data?.length ?? 0} models visible`);
    console.log(C.dim(
      `\n  ${provider.label} publishes no spend or quota endpoint, so this tool\n` +
      '  cannot show you what is left. `external-review quota` explains what the\n' +
      '  limits are and where the only real number lives.'));
  }

  // EXIT CODE, not just prose. `doctor && run` is the natural thing to write,
  // and a doctor that prints "Some checks want attention" while exiting 0 lets
  // that chain proceed into a pass that cannot work. Unattended callers branch
  // on status, not on adjectives.
  console.log(bad ? C.y('\nSome checks want attention.\n') : C.g('\nReady.\n'));
  process.exitCode = bad ? 1 : 0;
}

function findRunner() {
  for (const c of [join(homedir(), '.opencode/bin/opencode'), 'opencode']) {
    if (c.startsWith('/') ? existsSync(c) : spawnSync('which', [c]).status === 0) return c;
  }
  return null;
}

// ------------------------------------------------------------------- quota

async function cmdQuota(args = []) {
  const provider = resolveProvider(args);
  if (!provider.caps.spend) return quotaWithoutAnEndpoint(provider);
  const { data } = await api(provider, '/key');
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

/* What to say when the provider will not tell you.
 *
 * The temptation is to print a table of zeroes. That reads like "you have spent
 * nothing and may proceed", which is a claim this tool cannot make. So it says
 * what the published limits are, where the only authoritative number lives, and
 * what will happen when it runs out.
 */
function quotaWithoutAnEndpoint(provider) {
  if (provider.id !== 'nvidia') {
    console.log(C.y(`\n  ${provider.label} publishes no quota endpoint.\n`));
    return;
  }
  console.log(C.b(`\n${provider.label}\n`));
  console.log(C.dim(
    '  There is no quota API. The credit balance exists only in the web UI:\n' +
    '  https://build.nvidia.com → your account → API credits.\n'));
  console.log(C.y('  What the free tier is'));
  console.log(C.dim(
    '  cost           free, permanent key on signup, no card. NVIDIA REMOVED\n' +
    '                 the old credit cap (widely quoted as 1,000) - there is no\n' +
    '                 credit balance in the console any more, and a tool that\n' +
    '                 still quotes one is repeating a stale blog post.\n' +
    '  requests       unlimited. There is no daily cap either.\n' +
    '  rate           40 requests/minute - per model AND account-wide, so\n' +
    '                 switching model does not buy a fresh window. Increases to\n' +
    '                 200/min are granted on request in the developer forums.\n' +
    '  what stops you RATE, not budget. An agentic pass bursts well past 40/min\n' +
    '                 and dies mid-review having read everything and written\n' +
    '                 nothing. Run ONE pass at a time and re-run a killed one -\n' +
    '                 re-running costs nothing here, which is the whole\n' +
    '                 difference from a daily-capped provider.\n'));
  console.log(C.y('  Two terms that matter more than the credits'));
  console.log(C.dim(
    '  Read `external-review providers <model>` before your first pass. The\n' +
    '  NVIDIA API Trial Terms of Service prohibit submitting confidential data\n' +
    '  and prohibit production use - both are contractual, not advisory, and\n' +
    '  neither has an equivalent on OpenRouter.\n'));
}

/* How many passes actually fit, across everything you have configured.
 *
 * The observed failure this exists to prevent: a long pass dies at the daily
 * cap having READ a lot and REPORTED nothing, and the reason appears only in
 * stderr. Knowing the budget after that happens is worthless; the number has to
 * arrive before the scope is chosen.
 *
 * A pass is taken as ~40-150 requests. That is a measured range from real
 * whole-subsystem reviews, not a guess, but it varies with how much the model
 * chooses to read - which is why this reports a RANGE and never a single
 * comforting number.
 */
const PASS_COST = { min: 40, typical: 90, max: 150 };

function cmdPlan(args) {
  const known = allProviders();
  const only = argValue(args, '--provider');
  const entries = Object.entries(known).filter(([id]) => !only || id === only);

  console.log(C.b('\nWhat fits, per provider\n'));
  const advice = [];
  for (const [id, p] of entries) {
    const key = apiKey({ ...p, env: p.env, authStoreKey: p.authStoreKey }, { required: false });
    const l = p.limits || {};
    console.log(`  ${C.c(id.padEnd(12))} ${key ? C.g('key present') : C.y('no key')}`);
    if (l.resets === 'utc-day' && l.perDay) {
      const lo = Math.floor(l.perDay / PASS_COST.max);
      const hi = Math.floor(l.perDay / PASS_COST.min);
      console.log(`    budget      ${l.perDay} requests/day, resets on the UTC day`);
      console.log(`    fits        ${lo === hi ? lo : `${lo}-${hi}`} full pass(es) per day` +
        (lo === 0 ? C.y('  ← a broad pass may not finish') : ''));
      if (lo === 0) {
        advice.push(`${id}: too small for a broad sweep. Spend it on VERIFYING findings ` +
          '(1-3 requests each) or on one narrow, high-stakes scope.');
      }
    } else if (l.resets === 'rate-only') {
      console.log(`    budget      ${C.g('unlimited requests')} - no credit cap, no daily cap`);
      console.log(`    fits        as many passes as you like, ONE AT A TIME`);
      advice.push(`${id}: unlimited, so the constraint is pacing rather than ` +
        'rationing. A pass dies on the per-minute ceiling, not on a budget - ' +
        'run them sequentially and re-run a killed one rather than counting them.');
    } else {
      console.log(`    budget      ${C.dim('not published to this tool')}`);
      advice.push(`${id}: limits unknown. Run one narrow pass first and watch for a ` +
        'rate-limit error before committing a long one.');
    }
    if (l.perMinute) {
      // Measured, and revised DOWNWARD once the measurement came in properly.
      // First observation was "3 concurrent, 1 died" and the guidance written
      // from it said 2 were safe. Watching the rest of that run, a SECOND pass
      // died at the same ceiling; only one survived to finish. So an agentic
      // pass on its own can approach a 40/min ceiling, and the honest number is
      // one. 200/min providers get two - not from data, which is why it says so.
      const safe = l.perMinute >= 200 ? 2 : 1;
      console.log(`    rate        ${l.perMinute}/min  ` +
        C.dim(`→ run ${safe} pass at a time; a pass BURSTS, so this ceiling binds first`));
      if (safe === 1) {
        console.log(C.dim(
          '                ' +
          'even a single pass can reach this ceiling and die mid-review,\n                ' +
          'after reading the subsystem and before writing anything.'));
      }
    }
    if (l.note) console.log(C.dim(`    ${l.note.replace(/(.{68}\s)/g, '$1\n    ')}`));
    console.log();
  }

  if (advice.length) {
    console.log(C.y('  How to spend it\n'));
    for (const a of advice) console.log(C.dim(`  - ${a.replace(/(.{70}\s)/g, '$1\n    ')}`));
    console.log(C.dim(
      '\n  General shape: broad DISCOVERY on the largest budget, adversarial\n' +
      '  VERIFICATION on the scarcest one. Verification is a few requests per\n' +
      '  finding and benefits most from a model of a different lineage, so a\n' +
      '  small daily allowance is worth more there than as a third sweep.\n'));
  }
}

// ------------------------------------------------------------------ models

async function cmdModels(args) {
  const provider = resolveProvider(args);
  const wantFree = args.includes('--free');
  const wantAll = args.includes('--all');
  const limit = Number(argValue(args, '--limit') ?? (wantAll ? 1e9 : 25));
  const minCtx = Number(argValue(args, '--min-context') ?? 60000);

  if (!provider.caps.contextLength) return modelsWithoutMetadata(provider, { limit, wantFree });

  const { data } = await api(provider, '/models');
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

/* Listing when the catalog publishes ids and nothing else.
 *
 * Ranking by context window is the whole method - a model that cannot hold the
 * subsystem cannot review it - and NVIDIA's OpenAI-compatible /models returns
 * no context length, no pricing, no per-endpoint anything. So this prints the
 * ids and says plainly which question it cannot answer, rather than sorting by
 * something irrelevant and looking authoritative.
 */
async function modelsWithoutMetadata(provider, { limit, wantFree }) {
  const { data } = await api(provider, '/models');
  const ids = data.map((m) => m.id).sort();
  console.log(C.b(`\n${ids.length} model(s) on ${provider.label}\n`));
  if (wantFree) {
    console.log(C.dim(
      '  --free is meaningless here: every catalog model draws on the same\n' +
      '  credit pool, so nothing is free and nothing is separately priced.\n'));
  }
  for (const id of ids.slice(0, limit)) console.log(`  ${id}`);
  if (ids.length > limit) console.log(C.dim(`\n  …${ids.length - limit} more. --all to list them.`));
  console.log(C.y('\n  What this listing cannot tell you'));
  console.log(C.dim(
    '  This endpoint publishes ids only - no context window, no price, no\n' +
    '  per-endpoint metadata. Since ranking by context is how you pick a review\n' +
    '  model, check the window on the model\'s page at build.nvidia.com before\n' +
    '  you commit a pass to it. A model that cannot hold the subsystem will\n' +
    '  truncate it and review the part it kept, silently.\n'));
  console.log(C.dim('  Next: `external-review providers <id> --provider nvidia`.\n'));
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// --------------------------------------------------------------- providers

async function cmdProviders(args) {
  const provider = resolveProvider(args);
  const flags = new Set(['--provider']);
  const model = args.find((a, i) => !a.startsWith('-') && !flags.has(args[i - 1]));
  if (!model) die('usage: external-review providers <model-id> [--provider ID]');

  if (!provider.caps.endpoints) return providerIsTheOperator(provider, model);

  const [{ data: detail }, { data: providers }] = await Promise.all([
    api(provider, `/models/${model}/endpoints`),
    api(provider, '/providers'),
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


// -------------------------------------------------------------------- scan

/* Content-based secret detection.
 *
 * The exclusion list catches a credential that lives in a FILE NAMED like a
 * credential. It does nothing about the far commoner case: a live key pasted
 * into an ordinary source file. `config.js` matches no pattern, and ships.
 *
 * Patterns are deliberately high-signal. A scanner that cries wolf gets
 * `--force`d past on the second run and then protects nobody, so anything
 * heuristic enough to fire on real code is left out. This finds keys with
 * distinctive prefixes and real private-key blocks; it will NOT find every
 * secret, and the report says so rather than implying a clean bill of health.
 */
/* A private key SPANS LINES, so the per-line scan below cannot see it: the
 * header is on one line and the base64 on the next. It also needs that base64
 * to be present at all - a lone header is almost always a PARSER stripping it,
 * which is what a real repo's only false positive of this class turned out to
 * be. So it gets its own whole-text pattern, matched separately.
 */
/* A first-party catalog: one operator, no routing, but real terms.
 *
 * OpenRouter's version of this command answers "which of several companies
 * might receive your source". On NVIDIA's catalog that question is trivial -
 * NVIDIA runs it - and the interesting question moves to the contract. Two of
 * its clauses have no OpenRouter equivalent and both are quoted here from the
 * primary source rather than paraphrased from a blog, because the marketing
 * pages and the Terms of Service disagree with each other and the ToS is the
 * one you actually agreed to.
 */
function providerIsTheOperator(provider, model) {
  console.log(C.b(`\n${model}  ${C.dim('via ' + provider.label)}\n`));
  console.log(`  ${C.c('NVIDIA Corporation')}`);
  console.log('    headquarters  US (Santa Clara, CA)');
  console.log(`    routing       ${C.dim('none — first-party catalog, NVIDIA serves every request')}`);
  console.log(`    endpoint      ${C.dim(provider.base)}`);
  console.log(`    terms         ${C.dim('https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf')}`);
  console.log(`    privacy       ${C.dim('https://www.nvidia.com/en-us/about-nvidia/privacy-policy/')}`);

  console.log(C.y('\n  Two clauses to read before you send anything\n'));
  console.log(C.dim(
    '  1. YOU AGREE NOT TO SUBMIT CONFIDENTIAL DATA. Not "it may be trained on"\n' +
    '     — you undertake not to send it. §2.6(a): you agree you will not\n' +
    '     "include any confidential information, controlled or sensitive data,\n' +
    '     including protected health information, personal data ... or data that\n' +
    '     was processed or collected in violation of law".\n' +
    '     This is stronger than OpenRouter\'s free-tier trade. There, sending\n' +
    '     private code is a risk you accept; here it is a breach of the terms.\n' +
    '     Client code under NDA does not belong on this endpoint at any price.\n\n' +
    '  2. TRIAL USE ONLY, NOT PRODUCTION. §1.2 grants access "for limited trial\n' +
    '     purposes only and without use of the API Service or Generated Content\n' +
    '     in production". Reviewing your own source is development and testing,\n' +
    '     so a code review sits inside that. Wiring the same key into CI that\n' +
    '     gates releases does not, and NVIDIA AI Enterprise is the licence for\n' +
    '     that.\n'));
  console.log(C.y('  What NVIDIA says it does with what you send\n'));
  console.log(C.dim(
    '  §3.3 collects session metrics, error and execution logs, your feedback,\n' +
    '  "and (iv) User Content and Generated Content to improve NVIDIA products\n' +
    '  and services, including AI models". Use "will be logged for security,\n' +
    '  fraud or abuse monitoring and shared with third party service providers".\n' +
    '  §2.4 sets a 30-day store for User Content on the services that keep it,\n' +
    '  with security logging on top of that.\n\n' +
    '  Some NVIDIA marketing pages describe the catalog as stateless with no\n' +
    '  content logging. That is not what the Terms of Service you accepted say.\n' +
    '  Where they disagree, believe the contract.\n'));
  console.log(C.dim(
    '  Verdict, so you can decide rather than guess: fine for open source and\n' +
    '  for your own projects. Not for anything under an NDA, a customer\n' +
    '  contract, or a data-residency rule — there, the answer is a paid endpoint\n' +
    '  whose terms you have read, ZDR, or a model you host yourself.\n'));
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\r\n\\]+\s*[A-Za-z0-9+/=]{20,}/;

const SECRET_PATTERNS = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe live key', /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['OpenRouter key', /\bsk-or-v1-[A-Za-z0-9]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['JWT', /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['connection string with password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/],
];

/* Hosts that CANNOT be real, so a credential pointing at one cannot be real.
 *
 * RFC 2606 and RFC 6761 reserve these precisely so documentation can show a
 * full URL without it resolving anywhere. Found by running the scanner over a
 * repo whose test file contains the comment "https://mailto:x@example.com" —
 * structurally a connection string with a password, semantically a note about
 * a URL-parsing bug.
 *
 * This is a narrowing with no false-negative cost: a live credential is never
 * reachable at example.com. Everything else still trips the rule, including
 * an internal hostname, because "we think that host is private" is exactly the
 * assumption that leaks.
 */
const UNREACHABLE_HOSTS = /(?:^|[@.\/])(?:example\.(?:com|net|org)|test|invalid|localhost)(?![a-z0-9-])/i;

const SCAN_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'build', 'dist', 'target', '.venv', 'venv',
  '__pycache__', '.dart_tool', '.gradle', 'Pods', 'vendor', '.next',
]);

const SCAN_SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip',
  '.gz', '.tar', '.mp4', '.mov', '.mp3', '.woff', '.woff2', '.ttf', '.otf',
  '.jks', '.keystore', '.p12', '.der', '.apk', '.aab', '.so', '.dylib',
]);

/* Files whose "secrets" are public by design.
 *
 * Firebase client config (API key, app id, sender id) is an IDENTIFIER, not a
 * credential: Google documents it as safe to embed, and access is gated by app
 * signature / bundle id and security rules, not by the key. Every mobile repo
 * has these committed, so flagging them trains people to ignore the scanner -
 * which costs more than the warning is worth.
 */
const PUBLIC_BY_DESIGN = [
  /(^|\/)google-services\.json$/,
  /(^|\/)GoogleService-Info\.plist$/,
  /(^|\/)firebase_options\.dart$/,
  /(^|\/)firebase-config\.(js|ts|json)$/,
];

function scanTree(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf('.');
      if (dot > 0 && SCAN_SKIP_EXT.has(e.name.slice(dot).toLowerCase())) continue;
      const rel = full.slice(root.length + 1);
      if (PUBLIC_BY_DESIGN.some((re) => re.test(rel))) continue;
      let text;
      try {
        if (statSync(full).size > 2_000_000) continue; // not source
        text = readFileSync(full, 'utf8');
      } catch { continue; }
      if (text.includes('\u0000')) continue; // binary

      const pem = PRIVATE_KEY_BLOCK.exec(text);
      if (pem) {
        hits.push({
          file: rel,
          line: text.slice(0, pem.index).split('\n').length,
          label: 'private key block',
        });
      }

      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const [label, re] of SECRET_PATTERNS) {
          const m = re.exec(lines[i]);
          if (!m) continue;
          // A credential aimed at a reserved host is documentation, not a leak.
          if (UNREACHABLE_HOSTS.test(m[0])) continue;
          hits.push({ file: rel, line: i + 1, label });
          break;
        }
      }
    }
  };
  walk(root);
  return hits;
}

function cmdScan(args) {
  const root = argValue(args, '--in') ?? process.cwd();
  const hits = scanTree(root);

  if (hits.length === 0) {
    console.log(C.g(`\n  no high-signal secrets found in ${root}`));
    console.log(C.dim(
      '\n  This is NOT a clean bill of health. It looks for credentials with\n' +
      '  distinctive shapes - key prefixes, private-key blocks, passworded\n' +
      '  connection strings. A bare 32-character token in a config file looks\n' +
      '  exactly like any other string and cannot be found this way.\n' +
      '  Read your own diff before sending it somewhere.\n'));
    return hits;
  }

  console.log(C.r(`\n  ${hits.length} possible secret(s) in ${root}\n`));
  for (const h of hits) {
    console.log(`  ${C.y(h.label.padEnd(28))} ${h.file}:${h.line}`);
  }
  console.log(C.dim(
    '\n  Filename exclusions would NOT stop these - they are inside ordinary\n' +
    '  source files. Before sending this tree to a model:\n' +
    '    - move the value to an environment variable, or\n' +
    '    - add the file with --exclude, or\n' +
    '    - confirm it is a placeholder / already-public identifier.\n' +
    '  If a live credential has already been sent, rotate it. A provider\n' +
    '  retention policy is not a recall.\n'));
  return hits;
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

  // SCAN BEFORE SENDING, and refuse by default. This is the whole reason the
  // command exists rather than telling people to run rsync themselves: the
  // moment a review copy leaves the machine is the last moment anything can be
  // done about a key inside it.
  if (!args.includes('--skip-scan')) {
    const hits = cmdScan(['--in', src]);
    if (hits.length && !args.includes('--force')) {
      die('refusing to sync. Resolve the findings above, or pass --force if ' +
          'every one is a placeholder or an already-public identifier.');
    }
    if (hits.length) info('--force given; syncing anyway');
  }

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
    const verdict = verifySyncVerdict(out);
    if (verdict.leaked.length) {
      console.error(C.r('\nSecrets reached the review copy:'));
      verdict.leaked.forEach((l) => console.error(`  ${l}`));
      die('delete the remote copy and re-sync with the right --exclude flags');
    }
    // FAIL CLOSED. "No LEAKED lines" is only evidence when the check actually
    // RAN. An unreachable host, a refused key, a wrong remote dir or a missing
    // ssh binary all produce empty stdout - which used to print the same green
    // "verified" as a clean copy. The command then told you your secrets were
    // absent from a machine it had never successfully reached.
    //
    // VERIFY_DONE was already being echoed for exactly this purpose and was
    // never checked. That is the marker; ssh's own status is the second half.
    if (!verdict.ran) {
      console.error(C.r('\n  VERIFICATION DID NOT RUN - this is not a clean result.'));
      console.error(C.y(`  ${verdict.why}`));
      console.error(C.dim(
        '  The copy may be fine, but nothing here has looked at it. Re-run the\n' +
        '  check, or delete the remote copy if you cannot.\n'));
      die('could not verify the review copy');
    }
    console.log(C.g('\n  verified: no excluded path is present in the copy\n'));
  }
}

/* Did the remote verification actually run, and what did it see?
 *
 * Split out as a pure function because the interesting case has no remote host:
 * ssh failing produces the SAME empty stdout as a clean copy, and the caller
 * used to read that silence as proof. Anything that is not an ssh exit 0 with
 * the VERIFY_DONE marker present means the check did not happen.
 */
function verifySyncVerdict(out) {
  const stdout = out?.stdout || '';
  const leaked = stdout.split('\n').filter((l) => l.startsWith('LEAKED:'));
  if (out?.error) {
    return { ran: false, leaked, why: `ssh could not be run: ${out.error.message}` };
  }
  if (out?.status !== 0) {
    const err = (out?.stderr || '').trim().split('\n').slice(-1)[0] || '';
    return {
      ran: false, leaked,
      why: `ssh exited ${out?.status}${err ? ` - ${err}` : ''}`,
    };
  }
  if (!stdout.includes('VERIFY_DONE')) {
    return {
      ran: false, leaked,
      why: 'the remote check did not report completion (no VERIFY_DONE marker)',
    };
  }
  return { ran: true, leaked, why: '' };
}

function splitDest(dest) {
  const m = /^([^:]+):(.+)$/.exec(dest);
  return m ? [m[1], m[2]] : [null, dest];
}

// --------------------------------------------------------------------- run

function cmdRun(args) {
  const provider = resolveProvider(args);
  const promptFile = argValue(args, '--prompt');
  const rawModel = argValue(args, '--model');
  // Accept both `nvidia/moonshotai/kimi-k2` and the bare catalog id. The runner
  // needs the provider prefix; typing it twice is the commoner mistake.
  const model = rawModel && !rawModel.startsWith(provider.runnerPrefix)
    ? provider.runnerPrefix + rawModel
    : rawModel;
  const cwd = argValue(args, '--in') ?? process.cwd();
  const out = argValue(args, '--out') ?? join(tmpdir(), `review-${Date.now()}.md`);
  if (!promptFile || !model) {
    die('usage: external-review run --prompt FILE --model ID [--provider ID] [--in DIR] [--out FILE]');
  }
  if (!existsSync(promptFile)) die(`no such prompt file: ${promptFile}`);

  const runner = findRunner();
  if (!runner) die('no runner found. Install one: npm i -g opencode-ai');

  // A provider the runner has never heard of fails deep inside it, with a
  // message about an unknown model rather than about missing configuration.
  if (provider.id !== 'openrouter' && !runnerKnowsProvider(cwd, provider.id)) {
    die(`your runner has no "${provider.id}" provider configured.\n` +
        `  Run: external-review runner-config --provider ${provider.id} --write`);
  }

  // Pre-flight, because the documented failure is a run that dies at the cap
  // having read a lot and reported nothing. Refusing would be wrong - the user
  // may want a narrow pass, or may have bought credits since - but starting a
  // doomed sweep without a word is worse.
  const l = provider.limits || {};
  if (l.resets === 'utc-day' && l.perDay && l.perDay < PASS_COST.typical) {
    console.error(C.y(
      `\n  BUDGET WARNING: ${provider.label} allows ${l.perDay} requests/day and a ` +
      `whole-subsystem pass\n  typically costs ~${PASS_COST.typical} ` +
      `(${PASS_COST.min}-${PASS_COST.max}). This run may stop partway with nothing reported.`));
    console.error(C.dim(
      '  Narrow the scope, verify existing findings instead, or use a provider with\n' +
      '  more headroom. `external-review plan` shows what fits.\n'));
  }

  const prompt = readFileSync(promptFile, 'utf8');

  // SAY IT BEFORE THE WAIT, not after. The completeness check below can only
  // fire if the prompt NAMES a section it requires; a prompt that phrases the
  // requirement some other way silently opts out of its own verification, and
  // the pass then looks exactly as green as a checked one. Warning here costs
  // the reader two seconds; discovering it afterwards costs the whole pass.
  // A preflight prompt legitimately demands no sections - it demands one exact
  // sentence - so --expect suppresses the warning below rather than fighting it.
  const expect = argValue(args, '--expect');
  if (!expect && demandedHeadings(prompt).length === 0) {
    console.error(C.y(
      '\n  NOTE: this prompt names no required section, so the completeness\n' +
      '  check is INACTIVE for this run. A long answer that stops before the\n' +
      '  report will be accepted.'));
    console.error(C.dim(
      '  To enable it, demand a heading in the prompt - any of:\n' +
      '    a section "FINDINGS"   |   headed "FINDINGS"   |   End with FINDINGS:\n'));
  }
  info(`model   ${model}`);
  info(`scope   ${cwd}`);
  info(`output  ${out}`);

  // opencode resolves its OWN project root and ignores the spawn cwd. Getting
  // this wrong is not a crash: it treats the tree you meant to review as an
  // "external directory", auto-rejects every read in non-interactive mode, and
  // the model writes a paragraph about not being able to see anything. Pass the
  // directory explicitly.
  const dirFlag = /(^|\/)opencode$/.test(runner) ? ['--dir', cwd] : [];
  const maxRetries = Number(argValue(args, '--retry') ?? 0);

  const attempt = (retriesLeft) => {
  const child = spawn(runner, ['run', ...dirFlag, '-m', model, prompt], {
    // stderr is PIPED, not inherited, and re-emitted below. Inheriting it meant
    // the rate-limit and server-error classification below only ever saw
    // stdout - and runners put exactly those errors on stderr, so the most
    // common real failure was reported as a generic "exited 1". Streaming it
    // on keeps it usable as the liveness signal.
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so an idle timeout can take the runner's children
    // with it rather than orphaning them holding the pipes.
    detached: true,
  });
  let buf = '';
  let errBuf = '';

  // IDLE timeout, not a wall-clock one, and OFF unless asked for.
  //
  // A model can accept the request and never answer - measured on a provider
  // whose own web playground hung on the same model, with no error and no
  // close. The runner then waits forever and an unattended caller waits with
  // it. But a blanket timer is the wrong fix: some local CLI agents buffer
  // their entire output and emit it only on completion, so killing one on
  // elapsed time throws away work that was already done.
  //
  // So this fires only when NEITHER stream has produced a byte for the whole
  // window. A healthy agentic pass writes to stderr almost continuously (it
  // logs each file it opens), which is what makes silence on both streams a
  // usable signal rather than a guess.
  const idleSeconds = Number(argValue(args, '--idle-timeout') ?? 0);
  let idleTimer = null;
  let timedOut = false;
  const bump = () => {
    if (!idleSeconds) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      // Kill the group: the runner spawns children of its own, and killing
      // only the parent leaves them holding the pipes.
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }, idleSeconds * 1000);
  };
  bump();

  child.stdout.on('data', (d) => { buf += d; process.stdout.write(d); bump(); });
  child.stderr.on('data', (d) => { errBuf += d; process.stderr.write(d); bump(); });
  child.on('close', (code, signal) => {
    writeFileSync(out, buf);
    // Classify against BOTH streams: which one carries the error is the
    // runner's choice, not ours.
    const both = `${buf}\n${errBuf}`;
    const verdict = judgeRun(buf, prompt);

    // KILLED IS NOT FINISHED, and it used to exit 0. Node reports a signalled
    // death as code === null, `null !== 0` took the error branch, and
    // `process.exit(null)` then exited ZERO - a truncated pass reported as a
    // clean one. Worse for a buffering runner, which emits everything at the
    // end: killing it yields an empty file after it did all the work.
    clearTimeout(idleTimer);
    if (timedOut) {
      console.error(C.r(
        `\nNO OUTPUT ON EITHER STREAM FOR ${idleSeconds}s - treated as a hang.`));
      console.error(C.y('  The model accepted the request and never answered.'));
      console.error(C.dim(
        '  This is usually the MODEL, not you: providers serve some ids and\n' +
        '  quietly fail others, and a listing does not tell you which. Probe a\n' +
        '  different model with one request before re-running this scope.\n' +
        `  Whatever arrived is at ${out}\n`));
      process.exit(6);
    }
    if (signal) {
      console.error(C.r(`\nrunner was KILLED by ${signal} - this pass did not finish.`));
      console.error(C.y(`  Partial output (may be empty) kept at ${out}`));
      console.error(C.dim(
        '  If you wrapped it in a timeout: do not. Some runners buffer their\n' +
        '  whole output and emit it only on completion, so killing one throws\n' +
        '  away work that was already done. Let it finish and poll the file.\n'));
      process.exit(4);
    }
    if (code !== 0) {
      console.error(C.y(`\nrunner exited ${code}; partial output in ${out}`));
      // "exited 1" is not actionable; "you were rate limited" is. This is the
      // commonest way a pass dies, and it dies LATE - after the model has read
      // most of the subsystem and before it has written anything.
      // A 5xx is transient in the same way a 429 is - the pass is worth
      // repeating, and on a rate-capped provider repeating costs nothing. Kept
      // separate from the rate-limit branch because the ADVICE differs: there
      // is no window to wait out, so a short pause and a different model are
      // the useful suggestions.
      if (/\b5\d\d\b.*(server error|unexpected)|unexpected server error/i.test(both)) {
        console.error(C.y(
          `\n  ${provider.label} returned a SERVER ERROR, not a refusal.`));
        console.error(C.dim(
          '  Transient upstream failure: the model or its host fell over\n' +
          '  mid-pass. Nothing about your prompt or budget caused it.\n' +
          '  Re-run, and try a different model if it repeats - a single model\n' +
          '  can be unhealthy while the rest of the catalog is fine.\n'));
        console.error('RETRY_AFTER_SECONDS=60');
        if (retriesLeft > 0) {
          console.error(C.y(`  --retry: re-attempting in 60s (${retriesLeft} left)…\n`));
          setTimeout(() => attempt(retriesLeft - 1), 60_000);
          return;
        }
        process.exit(3);
      }
      // 402 / payment_required is OpenRouter's answer when the free-model
      // DAILY allowance is spent. It is not a rate limit - there is no window
      // to wait out and no burst to blame - and it is not a billing problem
      // either, which is what the words "payment required" will make a reader
      // assume. It clears at the UTC day boundary like any daily cap.
      if (/\b402\b|payment_required|payment required/i.test(both)) {
        const wait = rateLimitWaitSeconds({ limits: { resets: 'utc-day' } });
        console.error(C.y(
          `\n  DAILY FREE ALLOWANCE SPENT on ${provider.label}.`));
        console.error(C.dim(
          '  "payment_required" here does not mean a billing failure. The\n' +
          '  free-model requests for this UTC day are used up, that is all.\n' +
          '  Nothing is owed and nothing is broken.\n' +
          '  It resets at UTC midnight. Until then, run passes on another\n' +
          '  provider - `external-review plan` shows what is left where.\n'));
        console.error(`RETRY_AFTER_SECONDS=${wait}`);
        // Never auto-retry this one: --retry would sleep for hours.
        process.exit(3);
      }
      if (/\b429\b|too many requests|rate.?limit/i.test(both)) {
        const wait = rateLimitWaitSeconds(provider);
        console.error(C.y(
          `\n  RATE LIMITED by ${provider.label}` +
          (l.perMinute ? ` (its published limit is ${l.perMinute}/min).` : '.')));
        console.error(C.dim(
          '  An agentic pass BURSTS - it reads many files in quick succession - so\n' +
          '  the per-minute ceiling binds long before the daily one. Concurrency\n' +
          '  multiplies it: running N passes against one provider means N bursts.\n' +
          '  Reduce concurrency, or split the passes across providers.\n'));
        // A MACHINE-READABLE line, and a distinct exit code, because the caller
        // is usually a script or an assistant deciding what to do next. Telling
        // a human "reduce concurrency" does not help either of them; telling
        // them WHEN to come back does. Exit 3 = try again later, as opposed to
        // exit 2 = this run reviewed nothing and retrying will not fix it.
        console.error(`RETRY_AFTER_SECONDS=${wait}`);
        console.error(C.dim(
          `  Re-running costs nothing on a rate-capped provider - it is not a\n` +
          `  budget. Wait ~${Math.round(wait / 60)} min and run the same command again,\n` +
          '  or pass --retry to have this do it for you.\n'));
        if (retriesLeft > 0) {
          console.error(C.y(`  --retry: sleeping ${wait}s, then attempting again ` +
            `(${retriesLeft} left)…\n`));
          setTimeout(() => attempt(retriesLeft - 1), wait * 1000);
          return;
        }
        process.exit(3);
      }
      process.exit(code);
    }
    // --expect turns the preflight into something an unattended agent can BRANCH
    // on. "Run it and read the file" is not a check; a human reads a file, a
    // script needs a status. Exit 5 is distinct so a failed preflight is never
    // confused with a failed review.
    if (expect) {
      const norm = (t) => t.replace(/\s+/g, ' ').trim();
      if (norm(buf).includes(norm(expect))) {
        console.error(C.g(`\npreflight OK - the model answered as instructed.`));
        process.exit(0);
      }
      console.error(C.r(`\nPREFLIGHT FAILED: the output does not contain ${JSON.stringify(expect)}.`));
      console.error(C.y('  The setup is not usable yet; do not start a real pass.'));
      console.error(C.dim(`  What came back is at ${out}\n`));
      process.exit(5);
    }
    if (verdict.ok) {
      console.error(C.g(`\nwrote ${out}`));
      process.exit(0);
    }
    // A review that read nothing must not look like a review that found
    // nothing. This is the whole failure: exit 0, a file on disk, and a reader
    // who concludes the subsystem is clean.
    console.error(C.r(`\nTHIS RUN DID NOT REVIEW YOUR CODE. Output kept at ${out}`));
    console.error(C.y(`  ${verdict.why}\n`));
    for (const hint of verdict.hints) console.error(C.dim(`  ${hint}`));
    console.error();
    process.exit(2);
  });
  };
  attempt(maxRetries);
}

/* How long to wait before a rate-limited pass is worth retrying.
 *
 * Deliberately NOT a tight number. The providers do not send Retry-After on
 * these, and the counters are not exposed, so anything precise here would be
 * invented. These are conservative enough to be worth acting on: an agentic
 * pass that just exhausted a per-minute window needs the window to clear AND
 * the burst that filled it to age out.
 */
function rateLimitWaitSeconds(provider) {
  const l = provider.limits || {};
  // A daily cap will not clear in minutes - point at the reset instead of
  // suggesting a retry that is certain to fail again.
  if (l.resets === 'utc-day') {
    const now = new Date();
    const midnightUtc = Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(60, Math.round((midnightUtc - now.getTime()) / 1000));
  }
  return 420;
}

/* Decide whether a run that exited 0 actually reviewed anything.
 *
 * Written after a pass exited 0 having had every single file read rejected: the
 * runner resolved a different project root, refused the tree as an external
 * directory, and produced 147 bytes of apology. The exit code was 0 and the
 * output file existed, which is indistinguishable from a clean review unless
 * somebody opens it.
 *
 * Two signals, both conservative - this warns, it does not silently rewrite the
 * findings, and a genuinely short "this subsystem is sound" answer to a short
 * prompt still passes.
 */
/* Which section headings the PROMPT demands, across the phrasings people
 * actually write.
 *
 * This used to match one literal shape - `headed "X"` - and nothing else. Every
 * prompt either author actually wrote said `a section "HELD UP"` or
 * `End with HELD UP:`, so the completeness guard NEVER FIRED, on any pass, for
 * a whole day of reviews. Each of those passes looked exactly as green as if it
 * had been checked. A guard that silently does not apply is worse than no
 * guard, because it is counted as one.
 *
 * Kept conservative: an ALL-CAPS token, because that is what section headings
 * in these prompts look like, and matching ordinary words would fail runs for
 * saying "summary".
 */
function demandedHeadings(prompt) {
  const pats = [
    /headed\s+"([A-Z][A-Z ]{2,20})"/g,          // headed "HELD UP"
    /section\s+(?:called\s+|titled\s+)?"([A-Z][A-Z ]{2,20})"/g, // a section "HELD UP"
    /\b(?:end|finish|close)\s+with\s+(?:a\s+)?(?:section\s+)?"?([A-Z][A-Z ]{2,20}?)"?\s*[:.]/gi,
    /^#{1,3}\s+([A-Z][A-Z ]{2,20})\s*$/gm,     // ## HELD UP
  ];
  const out = new Set();
  for (const re of pats) {
    for (const m of prompt.matchAll(re)) {
      const h = (m[1] || '').trim();
      // Guard the loose "end with" pattern: only ALL-CAPS tokens are headings.
      if (h.length >= 3 && h === h.toUpperCase()) out.add(h);
    }
  }
  return [...out];
}

function judgeRun(output, prompt) {
  const hints = [
    'If the runner refused to read files: it resolved a different project root.',
    'Check --in points at the tree you mean, and that your runner can read it.',
    'Re-run with the runner directly to see its own errors.',
  ];
  const refusalMarkers = [
    /permission requested/i,
    /rejected permission/i,
    /external_directory/i,
    /rejected the permission/i,
  ];
  const refused = refusalMarkers.filter((re) => re.test(output));
  if (refused.length) {
    return {
      ok: false,
      why: 'The runner asked for permission to read your code and was refused, ' +
           'so the model never saw the files.',
      hints,
    };
  }
  // A review is a long answer to a long question. Coming back with a small
  // fraction of the prompt's own length means it did not engage with it.
  if (output.replace(/\s+/g, ' ').trim().length < Math.min(400, prompt.length / 4)) {
    return {
      ok: false,
      why: 'The runner produced almost no output - far less than the prompt it ' +
           'was given, which is not what a review looks like.',
      hints,
    };
  }
  // LENGTH IS NOT SHAPE. A pass can return kilobytes of thinking-aloud - "let me
  // read the store next", "I have a good picture now" - run out of room, and
  // stop before writing the report it was asked for. That output is long, has no
  // refusal marker, and is not a review. Observed on a real pass that returned
  // 11 KB of exploration and no findings at all.
  //
  // So: if the prompt DEMANDS a section heading, the output has to contain it.
  // Only headings the prompt actually names are required, which keeps this
  // honest for prompts that ask for something else entirely.
  const demanded = demandedHeadings(prompt);
  const missing = demanded.filter((h) => !output.includes(h));
  // A HEADING IS NOT A SECTION. A pass can print the required headings and stop,
  // or emit them with nothing underneath, and `includes()` calls that a pass.
  // Require some substance after each one - not a lot, because "this subsystem
  // is sound" is a legitimate one-line answer, but more than the heading itself.
  const hollow = demanded.filter((h) => {
    const i = output.indexOf(h);
    if (i < 0) return false; // already counted as missing
    const after = output.slice(i + h.length).replace(/^[\s:#*_-]+/, '');
    // Stop at the next demanded heading so one full section cannot mask an
    // empty one that follows it.
    const nextAt = demanded
      .map((o) => (o === h ? -1 : after.indexOf(o)))
      .filter((n) => n > 0);
    const body = (nextAt.length ? after.slice(0, Math.min(...nextAt)) : after).trim();
    return body.length < 40;
  });
  if (!missing.length && hollow.length) {
    return {
      ok: false,
      why: `These required sections are present but EMPTY: ${hollow.join(', ')}. ` +
           'A heading with nothing under it is a report that stopped, not a ' +
           'review that found nothing.',
      hints: [
        'Re-run: this is usually the model running out of room mid-report.',
        'A narrower scope leaves more room for the findings themselves.',
      ],
    };
  }
  if (missing.length) {
    return {
      ok: false,
      why: `The output never contains the section(s) the prompt required: ` +
           `${missing.join(', ')}. A long answer that stops before the report ` +
           'is not a short review, it is an unfinished one.',
      hints: [
        'Usually means the model ran out of room mid-exploration.',
        'Narrow the scope, or use a model with a larger context window.',
        'The partial output is kept - the leads in it are often still worth reading.',
      ],
    };
  }
  return { ok: true };
}


// -------------------------------------------------------------- stats

/* What a pass actually produced, counted rather than felt.
 *
 * Findings files are prose, so this parses the SHAPE the prompts ask for -
 * severity tags, file:line refs, the HELD UP and POLISH sections - and is
 * explicit about its own uncertainty. It is a reading aid, not an oracle: a
 * pass that formats its severities differently will undercount, and the output
 * says so rather than reporting a confident zero.
 *
 * The chart is drawn in text on purpose. A review summary belongs in the
 * terminal beside the findings, and a PNG would need a dependency for something
 * a bar of blocks says just as well.
 */
const SEV = ['P0', 'P1', 'P2'];

function readFindings(file) {
  const raw = readFileSync(file, 'utf8')
    // Strip ANSI, since these files are usually captured runner output.
    .replace(/\x1b\[[0-9;]*m/g, '');
  const lines = raw.split('\n');

  const counts = { P0: 0, P1: 0, P2: 0 };
  const files = new Map();
  let held = 0;
  let polish = 0;
  let section = 'findings';

  for (const line of lines) {
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) {
      const t = h[1].toUpperCase();
      if (t.includes('HELD UP')) section = 'held';
      else if (t.includes('POLISH')) section = 'polish';
      else if (t.includes('FINDING')) section = 'findings';
    }
    // A severity only counts once per line, and only in the findings section -
    // a HELD UP entry mentioning "the P1 above" is not another P1.
    if (section === 'findings') {
      const sev = SEV.find((x) => new RegExp(`\\b${x}\\b`).test(line));
      if (sev && /^\s*(#{1,3}|[-*]|\*\*)/.test(line)) counts[sev]++;
    }
    if (section === 'held' && /^\s*[-*]\s+/.test(line)) held++;
    if (section === 'polish' && /^\s*[-*]\s+/.test(line)) polish++;

    for (const m of line.matchAll(/([\w/.-]+\.(?:dart|js|ts|kt|swift|java)):(\d+)/g)) {
      // Key on the BASENAME. The same file gets cited as `worker.js` in one
      // finding and `backend/worker.js` in the next, and counting those apart
      // split the most-cited file in half - which is precisely the signal this
      // list exists to show.
      const base = m[1].split('/').pop();
      const prev = files.get(base);
      files.set(base, {
        n: (prev?.n ?? 0) + 1,
        // Keep the most specific spelling seen, so the display stays useful.
        path: (prev?.path ?? '').length >= m[1].length ? prev.path : m[1],
      });
    }
  }
  return { file, counts, held, polish, files, bytes: raw.length, lines: lines.length };
}

function bar(n, max, width = 28) {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width)));
}

function cmdStats(args) {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (!targets.length) {
    die('usage: external-review stats <findings.md> [more.md ...]');
  }
  const reports = [];
  for (const t of targets) {
    if (!existsSync(t)) die(`no such findings file: ${t}`);
    reports.push(readFindings(t));
  }

  const total = { P0: 0, P1: 0, P2: 0 };
  let held = 0;
  let polish = 0;
  const allFiles = new Map();
  for (const r of reports) {
    for (const k of SEV) total[k] += r.counts[k];
    held += r.held;
    polish += r.polish;
    for (const [base, v] of r.files) {
      const prev = allFiles.get(base);
      allFiles.set(base, {
        n: (prev?.n ?? 0) + v.n,
        path: (prev?.path ?? '').length >= v.path.length ? prev.path : v.path,
      });
    }
  }

  console.log(C.b(`\n${reports.length} pass(es)\n`));
  const maxSev = Math.max(1, ...SEV.map((k) => total[k]), held, polish);
  const row = (label, n, colour) =>
    console.log(`  ${label.padEnd(10)} ${String(n).padStart(3)}  ${colour(bar(n, maxSev))}`);
  row('P0', total.P0, C.r);
  row('P1', total.P1, C.y);
  row('P2', total.P2, C.dim);
  row('held up', held, C.g);
  row('polish', polish, C.c);

  if (reports.length > 1) {
    console.log(C.b('\n  per pass\n'));
    for (const r of reports) {
      const n = SEV.reduce((a, k) => a + r.counts[k], 0);
      console.log(`  ${String(n).padStart(3)} finding(s)  ${C.dim(`${r.held} held, ${(r.bytes / 1024) | 0} KB`)}  ${r.file}`);
    }
  }

  const hot = [...allFiles.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  if (hot.length) {
    console.log(C.b('\n  most-cited files\n'));
    const max = hot[0].n;
    for (const { n, path } of hot) {
      console.log(`  ${String(n).padStart(3)}  ${C.dim(bar(n, max, 16).padEnd(16))} ${path}`);
    }
  }

  console.log(C.y('\n  What these numbers are not\n'));
  console.log(C.dim(
    '  A count of CLAIMS, not of bugs. Findings get refuted - in one real\n' +
    '  session about half the P1s did not survive being checked against the\n' +
    '  code. Read `held up` as the calibration signal rather than the finding\n' +
    '  count as a score: a pass that independently re-derives things you know\n' +
    '  to be true is one whose findings are worth the time.\n\n' +
    '  Parsed from prose. A pass that tags severities differently undercounts\n' +
    '  here, and a zero may mean "nothing found" or "shape not recognised".\n'));
}

// ------------------------------------------------------- runner-config

/* Teach the runner about a provider it does not ship with.
 *
 * opencode knows OpenRouter natively and nothing else here does. Any
 * OpenAI-compatible endpoint needs four things declared in opencode.json - an
 * id, the openai-compatible SDK package, a baseURL and a key - plus the models
 * you want to appear. This writes that block, merging rather than replacing so
 * an existing config survives.
 *
 * The key goes in as `{env:NAME}`, never inlined: a config file gets committed,
 * copied to a review box and pasted into issues, and a key in it is a key
 * disclosed.
 */
function runnerConfigFor(provider) {
  if (provider.id === 'openrouter') {
    return { native: true };
  }
  return {
    provider: {
      [provider.id]: {
        npm: '@ai-sdk/openai-compatible',
        name: provider.label,
        options: {
          baseURL: provider.base,
          apiKey: `{env:${provider.env[0]}}`,
        },
        models: {},
      },
    },
  };
}

function runnerKnowsProvider(cwd, id) {
  if (id === 'openrouter') return true;
  for (const f of [join(cwd, 'opencode.json'), join(homedir(), '.config/opencode/opencode.json')]) {
    if (!existsSync(f)) continue;
    try {
      if (JSON.parse(readFileSync(f, 'utf8'))?.provider?.[id]) return true;
    } catch { /* a broken config is not a configured provider */ }
  }
  return false;
}

function cmdRunnerConfig(args) {
  const provider = resolveProvider(args);
  const models = (argValue(args, '--models') ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const block = runnerConfigFor(provider);

  if (block.native) {
    console.log(C.g(`\n  ${provider.label} needs no runner config — opencode knows it natively.\n`));
    return;
  }
  for (const m of models) block.provider[provider.id].models[m] = {};

  if (!args.includes('--write')) {
    console.log(C.b(`\n  opencode.json block for ${provider.label}\n`));
    console.log(JSON.stringify(block, null, 2));
    console.log(C.dim(
      `\n  Add it to ./opencode.json (this project) or ~/.config/opencode/opencode.json\n` +
      '  (everywhere), or re-run with --write (this project) or --write --global\n' +
      '  (everywhere) to merge it for you.\n' +
      `  Then export ${provider.env[0]} and restart the runner — it does not\n` +
      '  pick up provider changes while running.\n' +
      '  Model ids must match the catalog EXACTLY; add them with\n' +
      '  --models a,b or opencode will not list them.\n'));
    return;
  }

  // --global mirrors install-skill: a provider you configured once should not
  // have to be re-declared in every repo you review.
  const target = args.includes('--global')
    ? join(homedir(), '.config/opencode/opencode.json')
    : join(process.cwd(), 'opencode.json');
  mkdirSync(dirname(target), { recursive: true });
  let current = {};
  if (existsSync(target)) {
    try { current = JSON.parse(readFileSync(target, 'utf8')); }
    catch { die(`${target} is not valid JSON; refusing to overwrite it.`); }
  }
  // Merge, never clobber: this file is usually somebody's working config.
  current.$schema ??= 'https://opencode.ai/config.json';
  current.provider = { ...(current.provider || {}) };
  const existing = current.provider[provider.id];
  current.provider[provider.id] = {
    ...block.provider[provider.id],
    ...(existing || {}),
    models: { ...(existing?.models || {}), ...block.provider[provider.id].models },
  };
  writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`);
  console.log(C.g(`\n  merged into ${target}`));
  console.log(C.dim(
    `\n  Now: export ${provider.env[0]}=... and restart the runner.\n` +
    '  The key is referenced as {env:...}, never written to the file.\n'));
}

// ----------------------------------------------------------- install-skill

/* Copy the skill to where the assistant looks for it.
 *
 * A command rather than a documented `cp`, because the path depends on how the
 * package was installed: a GLOBAL install puts it under the npm root, a local
 * one under ./node_modules, and running from a clone puts it next to this file.
 * The README shipped the local path beside the global install instruction,
 * which is a paper cut on the very first thing a new user does.
 */
function cmdInstallSkill(args) {
  const global = args.includes('--global');
  const dest = join(global ? homedir() : process.cwd(),
    '.claude', 'skills', 'external-review');

  // Resolve relative to THIS file, so it works from a global install, a local
  // one, or a git clone without knowing which.
  const src = join(dirname(fileURLToPath(import.meta.url)),
    '..', 'skills', 'external-review');
  if (!existsSync(join(src, 'SKILL.md'))) {
    die(`cannot find the skill next to the CLI (looked in ${src})`);
  }

  if (existsSync(join(dest, 'SKILL.md')) && !args.includes('--force')) {
    die(`${dest} already exists. Pass --force to overwrite it.`);
  }

  mkdirSync(dest, { recursive: true });
  copyFileSync(join(src, 'SKILL.md'), join(dest, 'SKILL.md'));

  console.log(C.g(`\n  installed → ${dest}`));
  console.log(C.dim(
    `\n  ${global ? 'Available in every project.' : 'Available in this project.'}` +
    `${global ? '' : ' Use --global for every project.'}\n` +
    '  Now ask your assistant to "review this with a second model".\n'));
}

// -------------------------------------------------------------------- help

const HELP = `
${C.b('external-review')} — run a code review with a second, independent model.

${C.b('Commands')}
  install-skill [--global]   put the skill where your assistant will find it
  doctor                     check your setup and say what is missing
  quota                      spend so far, credit limit, and the free-tier cap
  plan [--provider ID]       how many passes actually fit, and where to spend them
  models [--free] [--all]    candidate models, ranked by context window
         [--min-context N] [--limit N]
  providers <model-id>       who actually serves that model, and from where
  stats <findings.md ...>    count what a pass produced, with a text chart
  runner-config [--write]    teach your runner a non-native provider
                [--global] [--models a,b]
  scan [--in DIR]            find credentials INSIDE source files, which no
                             filename exclusion can catch
  sync --to HOST:DIR         copy your source to a review machine, secrets
       [--from DIR] [--exclude PATH]   excluded — then VERIFY they are absent
  run --prompt FILE --model ID [--in DIR] [--out FILE] [--retry N]
      [--expect TEXT]        preflight: require this exact answer
      [--idle-timeout SECS]  give up if BOTH streams go silent that long

${C.b('Providers')}
  Every command takes ${C.c('--provider <id>')} (or $EXTERNAL_REVIEW_PROVIDER).
  ${C.c('openrouter')}  default. Many models behind one key; publishes who serves
              each one, from where, and under which policy.
  ${C.c('nvidia')}      build.nvidia.com. ~1,000 free credits, 40 req/min, one
              operator. Read ${C.c('providers')} first: its terms forbid sending
              confidential data and forbid production use.

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
  providers: cmdProviders, scan: cmdScan, sync: cmdSync, run: cmdRun,
  'runner-config': cmdRunnerConfig, 'install-skill': cmdInstallSkill, stats: cmdStats,
  plan: cmdPlan,
}[cmd];

if (!run) { console.log(HELP); process.exit(cmd ? 1 : 0); }
await run(rest);
