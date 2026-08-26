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

**"Free" is a business model, not a gift.** Free endpoints are frequently subject
to different data-retention terms than paid ones — often including using traffic
to improve models. If retention matters to you, read the policy for the specific
endpoint, and prefer a paid endpoint from a provider whose terms you accept.

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

## Running the review somewhere else

The remote workflow exists so the review runs on a machine that is not your
laptop — a VM, a spare box. That changes where the *runner* executes; it does
not change what is sent to the model. The privacy question is the same either
way. What it does buy you is a clean, dated, minimal copy of the source with the
secrets already stripped, which is easier to reason about than "my whole working
tree, including whatever I have uncommitted right now".
