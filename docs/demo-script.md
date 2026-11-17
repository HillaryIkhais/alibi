# ALIBI — Demo Video Script (2:30)

**Rule: nothing on screen that the machine did not produce.** No typed code,
no fake terminal success strings, no invented balances. If a scene cannot be
captured from a running system, CUT THE SCENE — do not fake it.

Target length: 2:30. Max: 3:00.

> **Revision note (honesty):** An earlier cut of this script showed a live
> "18/18 verifier checks pass" scene. That scene is now **CUT** because there is
> no committed `evidence/bundle.json` and the local regtest lab is desynced. The
> video below only contains scenes reproducible by the commands in
> `REPRODUCE.md`. Numbers must match `README.md` and `evidence/REAL_VS_MOCKED.md`.

---

## 0:00–0:15 — The problem (screen: title card + one line)

> "African freelancers sell through marketplaces, but handing a platform
> your Lightning wallet means handing it your money. Alibi gives the
> marketplace one narrow permission — collect its agreed fee — and nothing
> else."

Title card invariant:
**"Commission authority without wallet access."**

---

## 0:15–0:50 — The authority test (screen: adversarial + mutation runs)

Run, captured from a real terminal session:

```bash
node engine/bin/adversarial-test.js
node engine/bin/mutation-test.js
node engine/bin/concurrency-test.js
```

Voiceover, timed to the checks landing:

> "This is the vendor's wallet enforcing its own policy. The marketplace
> asked for 20% against a 5% limit — blocked. An unapproved payee — blocked.
> A replayed hash — blocked. Twelve for twelve."

Point at `TEST RESULTS: 12 passed, 0 failed`.

> "Then we attack the tests themselves. Each guard is deleted in turn, and
> the matching test is required to fail. Four for four — the guards are
> real, not decorative. The source file is restored byte-for-byte."

Point at `4/4 guards confirmed load-bearing` and `Byte-identical restore: YES`.

> "And under load — eight simultaneous requests against a budget that fits three — exactly three are
> approved, nothing over-commits. Five for five, single-process atomicity."

Point at `ATOMIC BUDGET RESERVATION: VERIFIED (single-process)`.

---

## 0:50–1:35 — The mechanism (screen: policy engine + SIM settlement flow)

Show `CommissionPolicy.validateCommission()` — the ordered checks (rate, payee,
budget, replay) — then run the SIM flow the machine can actually execute here:

```bash
node engine/bin/commission-flow-simulator.js
```

Voiceover:

> "Decode the invoice, cap the rate, check the payee, reserve the budget
> atomically, refuse a replayed hash — all before any hold invoice exists.
> The full state machine runs here in simulation: one buyer payment, a 5,000-sat
> commission at 5%, the vendor keeps 95,000. On screen: `FLOW COMPLETE`."

**On-screen, verbatim:** `"SIM mode — in-memory state; no real sats move."`

> "The buyer pays one invoice: 100,000 sats. Not 105,000. The commission comes
> out of what the creator received."

---

## 1:35–2:05 — Failure and recovery (screen: cancellation + audit pipeline)

Show the cancellation portion of the simulator output: buyer payment not settled,
no commission collected, budget reservation released, sale canceled safely.

Then run, captured:

```bash
(cd engine && node test/run-pipeline.mjs)
(cd auditor && node test/run-offline.mjs)
```

Voiceover:

> "If the deal falls through, the commission never settles, the buyer's held
> payment is released, and the budget returns to the vendor. The recovery
> pipeline passes 34 checks; the backup auditor passes 10 — force-close never
> wins automatically."

**On-screen, verbatim:** `"Offline checks use fixtures and a mock LND."`

---

## 2:05–2:30 — Close (screen: invariant + honesty line + repository)

> "Marketplaces can collect their fee. They cannot touch the wallet it came
> from. The policy is enforced by the wallet and proven by tests that fail
> when the guards are removed."

Repository URL. One line, verbatim:

*"Experimental NWC Commission Payments draft. Regtest. Policy layer proven
12/12 + 4/4. Live settlement verification not yet reproduced — disclosed in
README."*

---

## What was CUT and why (do not restore without evidence)

- The old "18/18 verifier checks pass on live regtest" scene — no `bundle.json`,
  lab desynced. Restore only after `REPRODUCE.md` §7 produces a committed bundle.
- Any on-screen "Verified on live LND regtest" status bar — same reason.

## Capture checklist

- [ ] `adversarial-test.js` captured fresh (12/12 pass)
- [ ] `mutation-test.js` captured fresh (4/4, byte-identical restore)
- [ ] `concurrency-test.js` captured fresh (5/5, no over-commit)
- [ ] `commission-flow-simulator.js` shows FLOW COMPLETE + cancellation invariants
- [ ] Pipeline (34) and auditor (10) outputs captured
- [ ] No preimage, macaroon, seed, or connection secret on screen
- [ ] Every spoken number matches `README.md` and `evidence/REAL_VS_MOCKED.md`
- [ ] No "18/18" or "verified on live regtest" claim appears anywhere

## Hard stops (do not publish if)

1. Any number appears that a command in `REPRODUCE.md` cannot regenerate.
2. Any scene uses placeholder invoice strings or typed success text.
3. The README, PRD, storyboard, and video disagree on any status — mismatch is
   negative evidence.
4. A live-verification scene is restored without a committed `bundle.json`.
