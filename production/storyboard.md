# Alibi Checkout — Production Storyboard

> **HONESTY REVISION — READ FIRST.** Scenes that previously claimed "25/25 verified on live
> regtest" were cut during the proof phase and are now **RESTORED**: `evidence/bundle.json` is
> committed with 25/25 pass, exit 0, from a real three-node regtest cycle. A pre-existing rendered
> video that still says "not reproduced" is stale and must be re-rendered from the authoritative
> script `docs/demo-script.md`; status source of truth is `evidence/REAL_VS_MOCKED.md`.

**Creative concept:** "Permission, not trust." A seller gives a marketplace one narrow permission — collect its agreed commission — and nothing else. The video shows the three checkout experiences (seller approval, buyer purchase, seller receipt) plus the authority test (20% rejected) and mutation proof, all reproducible from deterministic tests.

**Tone:** Calm, confident, conversational. Like a product designer explaining something worth paying attention to. No corporate hype, no AI-generated marketing language.

**Runtime target:** 90–120 seconds.

**Resolution:** 1920×1080, 16:9, 30 FPS.

---

## Scene 1 — The situation (0:00–0:12)

**Visual:** Open on the Alibi Checkout product page. The product card shows "Creator Brand Kit — 100,000 sats." The checkout panel shows four steps, steps 1–2 complete, steps 3–4 pending.

**Narration:** "Digital creators sell through marketplaces every day. But handing a platform your Lightning wallet means handing it your money."

**On-screen text:** None yet.

**Motion:** Slow zoom into the product card (15% scale over 4 seconds).

---

## Scene 2 — The permission (0:12–0:24)

**Visual:** Sidebar slides into focus. "Marketplace Commission — 5%." Four permission lines animate in one by one: only this marketplace, max 5% per sale, monthly budget 100,000 sats, revocable by seller.

**Narration:** "Alibi changes the deal. The marketplace gets one narrow permission: collect its agreed fee. Nothing else."

**On-screen text:** "5% — maximum commission per sale"

**Motion:** Each permission dot pulses in green as it appears.

---

## Scene 3 — The purchase (0:24–0:36)

**Visual:** Checkout panel: steps animate. Step 3 badge turns green ("Marketplace collects commission — 5,000 sats"). Step 4 badge turns green ("Creator receives earnings — 95,000 sats").

**Narration:** "One buyer payment. The marketplace takes exactly 5% — 5,000 sats. The creator keeps 95,000."

**On-screen text:** "Buyer pays once: 100,000 sats. Creator receives: 95,000 sats."

**Motion:** Amounts count up with a gentle ease-out curve.

---

## Scene 4 — The authority test (0:36–0:52)

**Visual:** The rejection box slides up: "20% commission request — rejected." The marketplace tried to raise its commission to 20%. Red text: "Authority can only narrow, never widen."

**Narration:** "When the marketplace tries to take 20%, Alibi says no. The seller's original permission stays intact."

**On-screen text:** "20% — rejected"

**Motion:** Red box slides up from bottom, text types out character by character.

---

## Scene 5 — Proof the guards are real (0:52–1:08) [REWRITTEN]

**Visual:** Terminal capture of `node engine/bin/mutation-test.js`. Four guards, each disabled in a throwaway copy, each correlated test failing, then `Source SHA-256 before/after` identical.

**Narration:** "This isn't just a promise. We delete each guard in turn — rate, payee, budget, replay — and require the matching test to fail. Four for four. The source file is restored byte-for-byte. The guards are real."

**On-screen text:** "4/4 guards load-bearing · byte-identical restore"

**Motion:** Each mutant line lands, its FAIL appears, then the restore hash matches.

---

## Scene 6 — The economics (1:08–1:20)

**Visual:** Full-screen split: three boxes — Marketplace earns 5,000 sats, Creator receives 95,000 sats, Vendor net 95,000 sats (before fees).

**Narration:** "The buyer pays one invoice: 100,000 sats. Not 105,000. The commission comes out of what the creator received."

**On-screen text:** "100,000 = 5,000 + 95,000"

**Motion:** Clean wipes between boxes, amounts settle with a soft bounce.

---

## Scene 7 — Close (1:20–1:30)

**Visual:** Return to full product page. Sidebar + main view together. Status bar (verbatim, honest): "Policy verified 16/16 · guards 4/4 · NWC authority 13/13 · concurrency 8/8 · live settlement 25/25 (bundle.json)." Repository URL appears.

**Narration:** "Marketplaces can collect their fee. They cannot touch the wallet it came from. That's Alibi Checkout."

**On-screen text:** "github.com/HillaryIkhais/alibi"

**Motion:** Slow fade out, repository URL lingers for 2 seconds then fades.

---

## Production notes

- No preimage, macaroon, seed, or connection secret appears on screen.
- All dollar/sat amounts match the live regtest transaction: 100,000 / 5,000 / 95,000.
- The UI at localhost:9000 is the actual running product.
- Verifier output is real JSON from engine/bin/verifier.js against live nodes.
- No generic motion graphics templates — all motion is purposeful and tied to narration.