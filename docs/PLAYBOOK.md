# Playbook

Everything below came out of running this against a production app and being
wrong in interesting ways. It is ordered by how much time each item saves.

---

## 1. The signature

Every real defect a second model found shared one shape:

> **The codebase already argued the correct rule somewhere else, and had not
> applied it here.**

Concretely, from one codebase in one day:

| The rule, stated | Where it was not applied |
|---|---|
| "a non-bool value reads as false instead of throwing and **dropping the whole bike**" | Two hard casts, two lines above |
| The sync path gated a one-time calibration on an adoption stamp | The link path gated it on "is the id null", so every reconnect recalibrated |
| A helper whose own doc says "never silently substitute another value" | Seven call sites that substituted zero |
| "back up the live document, but **only if it is good**" — argued in full | Two sibling stores that backed it up unconditionally, promoting corruption over the last good copy |
| "a bad tier entry costs that tier's line, never the record" | The object that *owns* the tiers hard-cast and lost the record |

Put this sentence in every review prompt. It converts an unbounded search into a
bounded one: enumerate the codebase's stated intentions, then check each one's
siblings.

**How to hunt it yourself:** grep for comments that explain *why* — "must",
"never", "otherwise", "this is why". Each one is a rule. For each rule, find the
other places of that shape and check them.

---

## 2. Four ways a vacuity check lies

You fixed something, wrote a regression test, and it passes. Before you believe
it, revert the fix and confirm the test fails. That check itself fails in four
ways, all observed:

### The revert did not apply
A scripted `replace` whose pattern did not match silently no-ops. The run
reports "all passed", which reads as *the test is vacuous* when in fact the fix
was never removed.

```python
old = "..."
assert old in source, "REVERT DID NOT APPLY"   # ← this line
source = source.replace(old, new, 1)
```

### It applied in the wrong place
A blind replace hitting the first of four identical lines in a large file. You
reverted something, just not the thing under test. Assert on a unique enough
anchor, or assert the resulting line count changed as expected.

### The run failed for the wrong reason
A compile error or a missing fixture is not your assertion failing. Check the
failure output names your test and your expectation — not the compiler.

### The test never reached the defect
The most common and the most convincing. The fixture looked right, the code path
was never entered, and the assertion was true for an unrelated reason.

Two real examples:

- A test for a "cancelled animation leaves the highlight stale" bug asserted on
  the **page position**, which moves whether or not the bug is present. It had to
  assert on the **highlight**.
- A test for "this value must not be shifted" set up a case where *no* shift
  happened at all, so the code path under test was skipped entirely and the value
  was untouched either way.

**Guard:** make the precondition the test's first assertion.

```dart
expect(pinBefore, closeTo(30, 0.01),
    reason: 'precondition: the pin is live, or this test proves nothing');
```

Know its limit: this catches a fixture that never reaches the defect. It does
**not** catch a wrong *second* step — a re-run at the same timestamp that takes a
different branch, say. Reverting the fix is the half that always works.

---

## 2b. A secret scanner's test fixtures look exactly like secrets

Worth knowing before you write them. The first commit of this repo's own scanner
tests was rejected by GitHub push protection: the fixture contained a
Stripe-key-shaped string, which is precisely what the test needs to contain.

The wrong fix is the allowlist link in the rejection message. It teaches the
repository to ignore that class of finding, and the next one might be real.

The right fix is to assemble the literal at runtime so it never appears in the
source:

```js
const stripe = ['sk', 'live', '51H8xQ2eZvKYlo2Cabcdefghijklmnop'].join('_');
```

Same reasoning as §3 below: a fixture that trains a safety mechanism to stay
quiet is worse than no fixture.

---

## 3. Your existing tests may pin the bug as correct

Two separate codebases had a test whose "corrupt record" fixture was really a
*recoverable* record with one mistyped field:

```dart
{'id': 'bad', 'year': 'not-a-number'}   // ← throws, so the record is skipped
```

The test asserted that this record gets **dropped**. It was green for months. It
was asserting that recoverable rider data gets deleted.

When you make decoding more tolerant, tests like this fail — and the reflex is to
"fix the test". Stop and ask which behaviour is right. Then repoint the fixture
at something genuinely undecodable (no id at all), so the skip path stays covered,
and add a test for the opposite direction.

---

## 4. Assert intact, not present

`expect(bike.components, hasLength(1))` passes for a component that survived
decode as a husk with every field defaulted. That is the same data loss in a
different shape.

Assert the *irreplaceable* field — the baseline, the service date, the price.
And where an autosave can make a loss permanent, drive the full round trip:

```dart
final once = Model.fromJson(damaged);
final twice = Model.fromJson(once.toJson());
expect(twice.components.single.serviceKmBaseline, 300);
```

---

## 5. Prompt shapes that worked

Scope to **one subsystem per pass**, and always include:

- Point at the invariant docs by name; say a violation is usually a real bug.
- The signature from §1, verbatim.
- What to EXCLUDE, so passes do not overlap.
- Required output per finding: severity, `file:line`, a concrete failure sequence
  **with specific values**, why existing tests miss it, the minimal fix.
- "Verify each claim against the code and quote the lines."
- "No style, naming or refactor opinions."
- "If a subsystem is sound, say so in one line rather than padding."
- "A confident wrong finding is worse than no finding."
- A cap: "stop at your 10 strongest." Quality tails off badly past that.

### Always ask for "HELD UP"

A section listing what it checked and found **correct**, one line each.

This is your calibration instrument. If it independently re-derives things you
know to be true, the findings are worth acting on. If it asserts something you
know is false, discount the whole pass. On one run the held-up section
independently traced a compliance firewall and confirmed no restricted data
reached an AI path — which was worth more than any single finding.

### Ask for "POLISH" on user-facing areas

Up to five concrete UX gaps with `file:line`: a state with no affordance, an
action with no feedback, a number with no unit, an empty state that says nothing.
Different question, different answers.

### Scope by journey, not by directory

"The first-run path: install → connect → first item → its photo" finds what
"review `lib/features/`" does not. Directory-shaped passes miss the handoffs
between modules, which is where bugs live. Feature-shaped passes cross them by
construction.

---

## 6. Reading findings

Real outcomes from real passes:

- **Refuted by reading the code.** The finding described a fall-through that did
  not exist. Cost: ten minutes. Worth it.
- **Wrong premise, real bug.** It named the wrong function as the trigger. The
  bug was real via a different path. **Read past the premise.**
- **First half wrong, second half a P0.** It claimed a fix had never been applied
  (it had — the model read a stale copy), and the *rest* of the same finding
  described a genuine data-loss path nobody had noticed.
- **Stale line numbers are a tell** that a finding was written against an old
  tree and never re-checked.

---

## 7. Practicalities

- **Sync to a dated directory**, never to a long-lived checkout — it may carry
  another session's uncommitted work, and you will review the wrong tree.
- **A pass will wander** into sibling checkouts if they exist on the machine.
  Put "work only inside the current working directory" in the prompt, and check
  the first lines of the output to see which tree it actually read.
- **Check the working directory of every pass you launch, not just the first.**
  This bit hard. Launching two in one shell line:

  ```bash
  cd ~/review-dir && nohup runner … & nohup runner … &     # WRONG
  ```

  The `&&` binds to the FIRST command only. The second runs in your home
  directory, finds a stale long-lived checkout next door, and reviews *that* —
  producing findings against code you fixed hours ago, with no error anywhere.
  The tell is in stderr: a correct pass reads `lib/foo.dart`, a wandering one
  reads `myproject/lib/foo.dart`. Wrap each launch in its own subshell:

  ```bash
  (cd ~/review-dir && nohup runner … &)
  (cd ~/review-dir && nohup runner … &)
  ```

  Related: never sync to a long-lived checkout in the first place. If the only
  copy on the machine is the dated one you just made, a wandering pass has
  nowhere stale to wander to.
- **Run two or three concurrently** on different scopes; a pass is mostly waiting
  on an API.
- **`stderr` is the liveness signal** — it shows which files are being read.
- **Reviewing your own session's recent work is the highest-value use.** That is
  exactly where your blind spots are. Several of the worst defects found this way
  were in code written hours earlier, including a comment that promised the exact
  behaviour its own code failed to deliver.
