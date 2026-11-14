# ALIBI — Demo Video Script (2:30)

**Rule: nothing on screen that the machine did not produce.** No typed code,
no fake terminal success strings, no invented balances. If a scene cannot be
captured from a running system, cut the scene — do not fake it.

Target length: 2:30. Max: 3:00.

---

## 0:00–0:15 — The problem (screen: title card + one line)

> "African freelancers sell through marketplaces, but handing a platform
> your Lightning wallet means handing it your money. Alibi gives the
> marketplace one narrow permission — collect its agreed fee — and nothing
> else."

Title card invariant:
**"Commission authority without wallet access."**

---

## 0:15–0:45 — The authority test (screen: vendor policy + adversarial run)

Run, pre-recorded from a real terminal session:

```bash
node engine/bin/adversarial-test.js
```

Voiceover, timed to the checks landing:

> "This is the vendor's wallet enforcing its own policy. The marketplace
> asked for 20% against a 5% limit — blocked. An unapproved payee — blocked.
> A replayed payment hash — blocked. Twelve for twelve."

Point at the summary line: `TEST RESULTS: 12 passed, 0 failed`.

---

## 0:45–1:30 — The complete transaction (screen: three nodes + payment flow)

Preconditions, stated honestly on screen if regtest:
*"Controlled Lightning regtest. Not mainnet. 18/18 verifier checks pass."*

Sequence (capture actual `lncli` / REST output):

1. Bob creates the 5,000-sat commission hold invoice, hash `H`.
2. Marketplace requests a commission-bound sale through NWC.
   Show the request method: `make_commission_invoice`.
   Show the vendor response: a real BOLT11 invoice (decoded payment hash matches).
3. Carol pays the single 100,000-sat invoice.
   Voiceover: *"The buyer pays one invoice. 100,000 sats. Not 105,000."*
4. Alice's wallet detects the held payment, pays Bob's commission invoice.
5. Bob settles with the preimage; Alice's sale settles.

Voiceover:

> "One buyer payment. The marketplace receives exactly its 5% — 5,000 sats.
> The vendor keeps 95,000, less routing fees. The marketplace never had
> permission to take anything else."

**On-screen verification:** `18/18 verifier checks pass — sale settled, commission settled, buyer paid, amounts reconcile, preimage matches hash`.

---

## 1:30–1:55 — Failure and recovery (screen: cancellation scenario)

> "Now the marketplace gets greedy — or the deal falls through."

Show the marketplace cancelling its commission hold invoice before capture.
Show the vendor's outgoing payment resolving as failed.
Show the buyer's held sale being cancelled only after the outgoing payment
is definitively resolved.

Voiceover:

> "The commission never settles. The buyer's payment is released back, not
> stolen. Budget reservation returns to the vendor."

---

## 1:55–2:15 — Independent verification (screen: verifier output)

```bash
node engine/bin/verifier.js > evidence/bundle.json
```

Voiceover:

> "This verifier holds read-only credentials and trusts nothing Alibi's
> own database says. It queries all three nodes directly: sale settled,
> commission settled, buyer payment found, amounts reconcile — 100,000
> equals 5,000 plus 95,000, preimage SHA256 equals payment hash, routing
> fee properly accounted. 18 out of 18 checks pass."

Show `summary: { passed, failed }` and the checksum line.

Voiceover, verbatim disclaimer:

> "This is node-backed verification of a controlled test network — not a
> consensus proof, and this is not a mainnet product."

---

## 2:15–2:30 — Close (screen: invariant + repository)

> "Marketplaces can collect their fee. They cannot touch the wallet it
> came from. The connection is scoped, the policy is enforced by the
> wallet, and the result is provable by a third party."

Repository URL. One line:
*"Experimental implementation of the NWC Commission Payments draft.
Regtest. 18/18 verified. Auditable."*

---

## Capture checklist

- [ ] `adversarial-test.js` run captured fresh (12/12 pass)
- [ ] Real BOLT11 invoice visible (not placeholder text)
- [ ] Three node identities visible from `getinfo`
- [ ] All payment legs settled, shown from node queries
- [ ] Verifier exits 0 with all 18 checks passing
- [ ] No preimage, macaroon, seed, or connection secret on screen
- [ ] No claim spoken that the evidence table in README labels
  incomplete while the video implies otherwise — mismatch is negative evidence

## Hard stops (do not publish if)

1. The verifier has not exited 0 against live nodes.
2. Any scene uses placeholder invoice strings.
3. The README evidence table still shows transaction status that the video
   contradicts — mismatch is negative evidence.