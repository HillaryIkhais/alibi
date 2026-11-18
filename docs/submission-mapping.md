# Submission field mapping

Fill from the event's official submission page. Use the event's exact words for track/prize names.
Paste the same numbers as the README — divergence is the most common credibility leak. Fill event
fields BEFORE the final day; do not invent them.

| Field | Content | Source |
|---|---|---|
| Project name | Alibi | PRD §1 |
| Tagline | "Commission authority without wallet access." | PRD §1 |
| One-liner | A vendor wallet that gives marketplaces narrow, revocable commission authority without ever granting general spending permissions. | PRD §1 |
| Problem | Marketplaces need a commission but get custody or broad wallet access; 0 wallet-side policy primitives exist. | README "The failure" |
| What it does | Configure policy → `make_commission_invoice` → atomic reservation → one buyer invoice → commission to approved payee → vendor keeps 95% → cancel releases. | README "mechanism" |
| How it works | Rate/payee/budget/replay checks before hold-invoice creation; restricted NWC method set; node-backed verifier. | README, `THREAT_MODEL.md` |
| Sponsor usage | `make_commission_invoice` (NWC draft nwc#8) is load-bearing in `commission-service.js` / `nwc-server.js`. **Confirm event sponsor first — if it requires a different chain integration, this mapping is invalid (red-team R1).** | README, `DECISIONS.md` D1 |
| What is real | Policy layer 14/14 + 4/4 + 5/5 + recovery 34/10 + credential hygiene; live 18/18 node-backed settlement VERIFIED on regtest (`bundle.json`, exit 0). | `evidence/REAL_VS_MOCKED.md` |
| Demo URL | [NOT DEPLOYED — static build of `interface/` can be hosted] | deploy |
| Video URL | [NOT YET RENDERED — follow `docs/demo-script.md`, honest cut] | video |
| Repo URL | https://github.com/HillaryIkhais/alibi (commit evidence and freeze before submitting) | git |
| Team | [FILL: names + roles] | PRD header |
| Tracks / prizes | [FILL: exact category names from event page] | event page |
| Event / deadline | [FILL: confirmed from event page — PRD line is deliberately UNCONFIRMED] | event page |

## Pre-fill blockers (must resolve before submitting)
1. **Confirm event / track / sponsor** (red-team R1). If sponsor fit depends on a chain integration Alibi lacks, reframe or withdraw from that prize.
2. **Freeze the repo** — commit all evidence, tag the submission commit, no post-deadline feature commits.
3. **Render the honest video** from `docs/demo-script.md` — the live "18/18" scene is now restorable from committed `bundle.json`; every on-screen number must match README.
4. **Optional but recommended:** host the static UI and run the clean-clone check (`REPRODUCE.md`) on a second machine.
5. Paste numbers verbatim from README; screenshot the submission confirmation.
