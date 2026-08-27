# external-review

**Review your code with a second, independent model — and know what it costs,
where your source goes, and which findings to believe.**

A Claude Code skill plus a small CLI. No dependencies.

---

## Why bother

Your assistant reviews its own work with the assumptions that produced it. A
model from a different lineage does not share them, so it sees defects yours
walks past — not because it is smarter.

In one day of use on a production mobile app, a second model found around forty
real defects that four in-house review passes had missed. Two were severe data
loss, and both are shapes you will recognise:

- **Reconnecting a device re-ran a one-time calibration**, silently erasing
  every unit of usage recorded while it was disconnected. The sync path had
  guarded against exactly this for months. The link path never did.
- **A single mistyped value in stored JSON deleted an entire record** — `1`
  where a boolean was expected — taking its children, its history and its
  attachments with it. The next autosave made it permanent. Seventeen fields
  had the same shape.

Both had one signature, and it is the thing this skill teaches you to hunt:

> **The codebase already argued the correct rule somewhere else, and had not
> applied it here.**

That reframing is most of the value. It turns "look for bugs" — a search over
infinite possibilities — into a search over the codebase's own documented
intentions, which is finite and enumerable.

---

## Install

### The CLI

```bash
npm install -g external-review
```

Or run it without installing:

```bash
npx external-review doctor
```

### The skill

```bash
external-review install-skill            # this project
external-review install-skill --global   # every project
```

Then ask your assistant to *"review this with a second model"* and it will pick
the skill up.

(It is a command rather than a `cp` because the source path differs between a
global install, a local one and a git clone. It refuses to overwrite an existing
skill unless you pass `--force`.)

### A model provider

The CLI talks to [OpenRouter](https://openrouter.ai), which fronts most models
behind one key and one API.

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

It also reads the key from [opencode](https://opencode.ai)'s auth store if you
already use that, so `opencode auth login` is enough.

You need a **runner** — something that can drive a model against a directory of
code. `opencode` is what this was built against:

```bash
npm install -g opencode-ai
```

---

## Use it

```bash
external-review doctor
```

```
external-review doctor

  ok   API key found  sk-or-v1…a037
  ok   a runner is installed  /Users/you/.opencode/bin/opencode
  ok   rsync available
  ok   ssh available
  ok   key reachable (free tier)  spent today: $0.0000

Ready.
```

### 1. Know your budget before you scope the work

```bash
external-review quota
```

```
Account

  tier               free
  spent today        $0.0000
  spent this month   $0.0000
  credit limit       none set

  Free-model request cap
  OpenRouter limits :free models to 50 requests/day, raised to 1000/day
  once the account has purchased 10 credits at any point. That cap is not
  exposed by the API, so it is not shown above — but it is what usually
  stops a long review.

  A whole-subsystem review is 40-150 requests. On the free tier that is
  ONE pass, maybe two. Add credits, or use stealth models, or expect to
  plan a day at a time.
```

This matters more than it sounds. Runs die **partway**, having read your code
and reported nothing, and the reason appears only in stderr.

There are **two separate pools**, which is why a day can run far past 50
requests and then stop abruptly:

| | pool | cap |
|---|---|---|
| `:free` models | `free-models-per-day` | 50/day, or 1000/day once you have ever bought 10 credits. 20/min either way. |
| stealth / cloaked | `free-models-per-day-stealth` | separate, much larger |

Both reset on the UTC day. The `:free` counter is account-wide, so switching
free models buys nothing — switching to a *stealth* model does.

### 2. Pick a model

```bash
external-review models --free
```

```
20 model(s) with ≥60k context, free only

  context   price / 1M tokens          id
    1049k   free in / free out         minimax/minimax-m3:free
    1000k   free in / free out         nvidia/nemotron-3-ultra-550b-a55b:free
     512k   free in / free out         dots-studio/dots-3-note-preview:free
```

Ranked by **context window**, deliberately. A model that cannot hold the
subsystem cannot review it. Then reasoning quality; price last, because review
reads a lot and writes a little.

### 3. Decide where your code is allowed to go

```bash
external-review providers nvidia/nemotron-3-ultra-550b-a55b
```

```
NVIDIA: Nemotron 3 Ultra

  Your prompt is sent to ONE of these, chosen per request.

  DeepInfra
    headquarters  US
    datacenters   not published
    privacy       https://deepinfra.com/privacy
    terms         https://deepinfra.com/terms

  Together
    headquarters  US
    ...
```

**This is the honest answer to "is it safe to send my code to a model I have
never heard of".** Not reassurance — facts. Who operates the machine, where
they are based, where they publish their datacenters, and a link to the policy
you would actually be agreeing to.

Note what the question actually turns on. **Who trained a model and who serves
it are different companies.** A model may be trained by one organisation and
run by four unrelated providers, any of which may take your request — and it is
the *operator* who sees your prompt. So "is this model from a country I trust"
is the wrong question; "what is this endpoint permitted to do with my code" is
the right one, and it is the one this command answers.

For a **free** model it adds the part people miss. OpenRouter will not route to
free endpoints at all unless your account has enabled *"free endpoints that may
train on inputs"* and *"free endpoints that may publish prompts"* — so if free
models work for you, those are on, and **the code you send may be trained on and
published.** That is the trade, and it is a reasonable one for open source. It
is not reasonable for code under an NDA.

For a **stealth** model — an unreleased model shipped anonymously to gather
usage — it tells you that no provider is published at all:

```
Ox Alpha

  This model does not disclose its providers.

  So the questions this command exists to answer — who operates it, from
  where, under which policy — have no available answer. What IS known is
  the arrangement: these models are offered free because prompts and
  completions are logged and used to improve them. That is their purpose,
  not a side effect.
```

The remedy, when you need one, is **Zero Data Retention**: an account toggle, a
per-key guardrail, or `"zdr": true` per request. It blocks storage and training
— and removes most free endpoints, which is the same trade seen from the other
side. [`docs/PRIVACY.md`](docs/PRIVACY.md) has the decision table.

### 3b. Or use a different provider entirely

Every command takes `--provider` (or `$EXTERNAL_REVIEW_PROVIDER`):

```bash
external-review models --provider nvidia
external-review runner-config --provider nvidia --write   # opencode.json block
export NVIDIA_API_KEY=nvapi-...
external-review run --provider nvidia --model moonshotai/kimi-k2 \
                    --prompt ./review.txt --out findings.md
```

| | `openrouter` (default) | `nvidia` — [build.nvidia.com](https://build.nvidia.com) |
|---|---|---|
| shape | router in front of many operators | NVIDIA's own catalog, one operator |
| free budget | 50 req/day, **resets daily** | **unlimited** — no credit cap, no daily cap |
| rate limit | 20/min | 40/min, 200 on request |
| discloses who serves it | yes | it is always NVIDIA |
| the catch | free endpoints require opting into training + publishing | its terms **forbid** confidential data and production use |

That last row is not a footnote. OpenRouter's free tier is a trade you accept —
your code may be trained on. NVIDIA's [API Trial Terms of
Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)
§2.6(a) has you **agree not to submit** confidential or sensitive data, so
sending NDA'd code there is a breach rather than a risk. §1.2 limits use to
trial purposes "without use of the API Service or Generated Content in
production" — reviewing your own source is inside that; release-gating CI is
not.

And the marketing and the contract disagree: some NVIDIA pages describe the
catalog as stateless with no content logging, while §3.3 says User Content is
collected "to improve NVIDIA products and services, including AI models".
`external-review providers <id> --provider nvidia` prints both and tells you
which one binds.

Adding another OpenAI-compatible endpoint is a few lines in `PROVIDERS` — the
commands adapt from a `caps` table, and one that cannot answer a question says
so rather than printing an empty result that reads like a clean bill of health.

### 3c. Know what fits before you scope the work

```bash
external-review plan
```

```
  openrouter   key present
    budget      50 requests/day, resets on the UTC day
    fits        0-1 full pass(es) per day  ← a broad pass may not finish
  nvidia       key present
    budget      unlimited requests - no credit cap, no daily cap
    fits        as many passes as you like, ONE AT A TIME

  How to spend it
  - openrouter: too small for a broad sweep. Spend it on VERIFYING findings…
  - nvidia: unlimited, so the constraint is pacing rather than rationing…
```

Daily caps and finite pools call for opposite tactics, so the tool says which
one you have rather than printing a number and leaving you the arithmetic.
`run` warns before starting a pass the daily budget cannot hold.

**Adding your own provider** takes no fork — `~/.config/external-review/providers.json`:

```json
{ "groq": { "base": "https://api.groq.com/openai/v1", "env": ["GROQ_API_KEY"] } }
```

Its capabilities default to *publishes nothing*, so it never claims limits or
metadata it does not have.

### 4. Run a pass

```bash
external-review run --prompt ./examples/prompts/data-integrity.txt \
                    --model nvidia/nemotron-3-ultra-550b-a55b:free \
                    --out findings.md
```

Reviewing on a VM or VPS? Recommended — but for narrower reasons than usual.
It does **not** change what the model sees; the prompt is identical either way.
What it does is contain the *runner*: a third-party binary running an agentic
loop with filesystem access, which on your laptop sits next to `~/.ssh`, your
cloud credentials and every other client's repo. On a throwaway box it sits next
to one dated copy of one project. [`docs/PRIVACY.md`](docs/PRIVACY.md) has the
full argument and a setup checklist.

Sync first — scanned, secrets excluded, then **verified absent**:

```bash
external-review sync --to you@review-box:~/review-2026-08-26 \
                     --exclude 'config/production.json'
```

```
  verified: no excluded path is present in the copy
```

The verification is the point. An exclusion pattern that silently failed to
match is the entire risk, so the command checks the copy over SSH rather than
trusting rsync's exit code.

---

## The part people skip, and shouldn't

**A finding is a claim, not a fact.** Reproduce before fixing.

Then, having fixed it and written a regression test, **revert the fix and
confirm the test fails.** There are four ways that check silently lies — all
observed in practice, all documented in
[`docs/PLAYBOOK.md`](docs/PLAYBOOK.md):

1. the revert did not apply (scripted replace, no assertion, silent no-op);
2. it applied in the wrong place;
3. the run failed on a compile error, not your assertion;
4. the test never reached the defect at all.

And check your *existing* fixtures do not pin the bug as correct. A "corrupt
record" fixture that is really a recoverable record with one mistyped field
asserts that recoverable data gets deleted — green for months, in two separate
codebases.

---

## Commands

| | |
|---|---|
| `install-skill [--global]` | put the skill where your assistant will find it |
| `doctor` | check the setup, say what is missing |
| `quota` | spend so far, credit limit, free-tier cap |
| `models [--free] [--all] [--min-context N] [--limit N]` | candidates by context window |
| `plan [--provider ID]` | how many passes fit per provider, and where to spend them |
| `providers <model-id>` | who serves it, HQ, datacenters, policy links |
| `runner-config [--write] [--models a,b]` | teach your runner a provider it does not ship with |
| `scan [--in DIR]` | find credentials **inside** source files, which no filename exclusion catches |
| `sync --to HOST:DIR [--from DIR] [--exclude PATH]` | scan, refuse if anything is found, copy excluding secrets, then verify |
| `run --prompt FILE --model ID [--in DIR] [--out FILE]` | run a pass |

---

## Docs

- **[`docs/PLAYBOOK.md`](docs/PLAYBOOK.md)** — the bug signature, prompt shapes
  that worked, and every way a verification step can lie to you.
- **[`docs/PRIVACY.md`](docs/PRIVACY.md)** — what leaves your machine, what does
  not, and how to decide.
- **[`examples/prompts/`](examples/prompts/)** — the actual prompts that found
  the bugs above, ready to adapt.

## Contributing

Findings about the *process* are the most valuable contributions — a new way a
vacuity check can lie, a prompt shape that outperformed, a failure mode worth
warning about. Open an issue.

## License

MIT
