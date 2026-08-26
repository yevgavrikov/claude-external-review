# What leaves your machine

A review means sending source code to a third-party API. That is the deal, and
it should be an informed one rather than a hopeful one.

## What is sent

**Your source files, in the clear, over TLS, to whichever provider serves the
model you chose.** The runner reads files in the directory you point it at and
puts their contents in the prompt. There is no filtering, no obfuscation, and no
way to review code without sending it.

Also sent: your prompt, and — for the CLI's own commands — nothing but the model
id you asked about.

## What is not sent

- Anything matched by the sync exclusions (see below).
- Your API key never leaves your machine except as an `Authorization` header to
  OpenRouter, which is what it is for.
- This tool has no telemetry. It makes no network calls except to
  `openrouter.ai` and, for `sync`, to the host you name.

## Deciding whether that is acceptable

Run:

```bash
external-review providers <model-id>
```

For every machine that may serve your request, this prints:

- the operator's **headquarters**,
- its published **datacenter regions**,
- links to its **actual privacy policy and terms**.

These are facts published by OpenRouter, not a rating. This tool does not tell
you which providers are trustworthy, because that is not a technical question
and the answer differs per user. What it does is make sure you are not guessing.

Things worth knowing while you decide:

**A model is routed per request.** If it lists four endpoints, any of the four
may serve a given call. To pin one, use OpenRouter's `provider.order` routing
or pick a model with a single endpoint.

**"Free" is a business model, and on OpenRouter the price is your data.** This
is stronger than a caveat and it is the single most important thing on this
page.

To use free models at all you must enable, in Settings → Privacy:

- *"Enable free endpoints that may train on inputs"*
- *"Enable free endpoints that may publish prompts"*

Without them, free models return
`404: No endpoints available matching your guardrail restrictions and data
policy`. So if free models work for you, those toggles are on, and **the code
you send is permitted to be trained on and published.**

**Stealth models are the same deal, more so.** A "stealth" or "cloaked" model is
an unreleased model shipped under an anonymous name to gather real-world usage.
That is the entire point: prompts and completions are logged and used to improve
it. They are attractive for review work — often frontier-class, large context,
free — and they are the least private option on the menu.

**Zero Data Retention is the actual control.** ZDR means a provider will not
store your data for any period, and cannot train on it. Enable it three ways:

- account-wide, in privacy settings, globally or per model group;
- per API key, as a guardrail, which is how you give a teammate a key that
  cannot leak;
- per request: `"zdr": true` in the provider preferences.

The cost is real: ZDR **removes endpoints**, including most or all free ones,
and it does not cover plugins such as web search, which carry their own
policies.

So the decision is simple to state, if not to make:

| If the code is… | Use |
|---|---|
| open source, or you do not mind it training a model | free endpoints — that is the trade |
| private but not contractually restricted | a paid endpoint whose terms you have read |
| under NDA, customer contract, or a residency rule | ZDR, or a model you host yourself |

Do not let "it is only a code review" carry the decision. A review prompt
contains more of your source, in one place, than almost anything else you send
anywhere.

**Self-hosting removes the question.** A local model via Ollama or vLLM, or a
model on infrastructure you control, sends nothing anywhere. It costs you
capability, and for reviewing a subsystem that tradeoff is often fine.

**Your obligations are yours.** If the code is under an NDA, a customer contract,
export control, or a regulation with data-residency requirements, none of the
above substitutes for checking. Ask, do not assume.

## Secrets

The most likely accident is not the model reading your code — you meant that.
It is a credential riding along inside it.

`external-review sync` excludes the usual shapes:

```
.env  .env.*  *.pem  *.der  *.key  *.jks  *.keystore  *.p12
*.mobileprovision  id_rsa*  *.crt
secrets.*  *.secrets.*  credentials.*  service-account*.json
.git/  node_modules/  build/  dist/  target/  .venv/  __pycache__/
```

Then it **verifies over SSH that those paths are absent from the copy**, because
an exclusion pattern that silently failed to match is the entire risk, and
`rsync` exits 0 either way.

**The default list cannot know about your repo.** Real example: a project's list
covered `*.jks` and `strava.config.json` but not `garmin/developer_key.pem` — a
code-signing key that would let someone publish releases as that developer. It
was only caught because a second person reviewed the list.

So: before the first sync, list your own credential paths and add them with
`--exclude`. Then read the verification output rather than assuming it passed.

If a secret does reach a review copy, treat it as disclosed: delete the copy,
rotate the credential, and do not rely on the provider's retention policy to
make it un-disclosed.

## Running the review on a VM or VPS

Worth doing. Also worth being precise about, because the reason people usually
give for it is the one thing it does not help with.

**It does NOT reduce what the model sees.** The prompt is byte-for-byte the
same whether the runner executes on your laptop or on a box in a datacenter.
If the endpoint may train on your code, it may train on it either way. Anyone
telling you a VM makes the *disclosure* safer is confusing two different risks.

**What it genuinely does:**

**1. It contains the runner, which is the under-discussed risk.** A review
runner is a third-party binary executing an agentic loop with filesystem access
and, usually, shell access. It reads whatever it decides it needs. On your
laptop that neighbourhood includes `~/.ssh`, your cloud credentials, your
browser profile, your password-manager exports, your other clients' repositories
and every uncommitted branch you have. On a throwaway VM it includes a dated
copy of one project.

That is not a hypothetical about malice — it is about scope. Agentic tools
wander. On a real run, a pass launched from the wrong working directory found a
sibling checkout and reviewed *that* instead, unprompted and without error. It
had no reason to and no instruction to. It just could.

**2. It keeps your API key off your daily machine.** The key lives on the box
that uses it. A key on a laptop is a key in a laptop backup.

**3. It forces a clean, dated, minimal copy.** You review exactly what you
synced — not your working tree with its uncommitted experiments, its `.env.local`
and its half-finished spike branch. This is also the only way `scan` and the
exclusion verification can mean anything, because they run against a snapshot
rather than a moving target.

**4. It makes the blast radius disposable.** If something goes wrong — a secret
synced by mistake, a runner that misbehaves — you destroy the VM. You cannot
destroy your laptop.

**How to set it up sensibly**

- A cheap VPS or a local VM is fine. It needs a shell, `rsync` and the runner;
  it does not need to be fast, because the work happens at the API.
- Give it **no standing credentials** beyond the model API key. No cloud
  provider keys, no deploy keys, no production access.
- Sync to a **dated directory per review**, never to a long-lived checkout.
  Delete it afterwards. A stale checkout on the review box is how a pass ends up
  reviewing code you fixed hours ago and reporting it as broken.
- Do not develop on it. The moment it becomes a second workstation it has the
  same neighbourhood problem as the first one.

**When it is not worth it:** reviewing open-source code you would publish
anyway. The runner-containment argument still applies, but the stakes are low
enough that a local run in a clean checkout is a reasonable trade.
