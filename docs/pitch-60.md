# 60-second oral pitch

Open with the failure, not the company. Stop at 60 seconds. Close on the verify command, not on gratitude.

---

"Here's the thing that goes wrong today: a marketplace needs to collect a 5% commission, and the only
way to let it do that on Lightning is to hand it your wallet — or custody of your funds. A vendor in
that position gets asked for 20% and has no way to refuse at the wallet level.

Alibi is the missing layer. The vendor grants one narrow permission — request a commission-bound sale
to one approved payee, within one budget — and the vendor's wallet enforces it. The marketplace never
receives `pay_invoice` or any settlement method. The invariant is simple: authority can only narrow,
never widen.

The enforcement is integer BigInt math and a single atomic budget reservation before any invoice
exists. We proved it three ways: twelve adversarial cases all blocked, four mutation tests showing
each guard is load-bearing — delete a guard, the matching test fails — and five concurrency checks
showing eight simultaneous requests against a budget for three approve exactly three, with no
over-commit.

The load-bearing primitive is the NWC Commission Payments draft's `make_commission_invoice` method.
Remove it and there's no product.

And it's not just simulation: the independent verifier ran against three live regtest LND nodes and
produced `evidence/bundle.json` with eighteen out of eighteen checks passing. Here's the limit, before
you ask: regtest node-state verification, not Bitcoin consensus or trustlessness — single-process
atomicity, no mainnet. The artifact and the restore procedure are in the repo.

Verify it yourself, right now: `node engine/bin/adversarial-test.js`, then `node engine/bin/mutation-test.js`.
That's Alibi — commission authority without wallet access."

---

**Three anchors to keep reflexive:** invariant = "authority only narrows"; test count = 16/16 + 4/4 + 8/8 + live 25/25; identifier = settlement hash `e01084644d8efb9975fe36f6948ed893a5d2cac2fb38114bea8dbe84d22ffa84` in `evidence/bundle.json`.
