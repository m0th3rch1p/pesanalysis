# Pesanalysis

**An on-device financial intelligence hub for Kenyan mobile money.** (Codename `yako`; Android id `dev.yako.app`.)

Pesanalysis reads the transaction messages already on your phone (M-PESA, Airtel Money, banks, lenders,
savings products), files them into a local encrypted ledger, and turns them into things no provider
shows you: what actually left your pocket this week, your free float before the next bill, the true
cost of fees and Fuliza, and the payments you meant to remember. All of it runs on the phone. There
is no bank login, no account, no analytics, no ads, and no upload.

Built for **AI Yako** (QVAC / Tether hackathon, Node NBO Nairobi, 24-31 Oct 2026), **Offline AI apps**
track. Every feature in the demo runs with the internet switched off.

## What the AI actually does (QVAC, on the phone)
The ledger is deterministic; models help where text is messy and are never trusted with numbers.

1. **Unknown-message help.** A financial-looking SMS that none of the parsers recognise is filtered by
   deterministic rules (amount + confirmation language, no codes or marketing), then Qwen3-0.6B proposes
   fields with a constrained JSON schema. Regex/arithmetic validators check the amount, date, direction
   and reference against the raw text. An accepted proposal becomes a **pending** transaction you confirm.
2. **Explain a finding.** A detector writes a plain sentence with exact numbers; Qwen3-0.6B rewrites it
   with a number-preservation guard and template fallback.
3. **Kiswahili.** TranslatePsy-AfriSLM translates the explanation text. Numbers and entities are masked
   before translation and verified afterwards; any mismatch falls back to English.
4. **Receipt photos.** QVAC OCR reads a till slip; deterministic rules pick the total, merchant and date,
   and warn when the receipt total differs from the payment.

Model choices, versions, sizes, licences, setup, measured device results and the honest limits are in
**[docs/QVAC_INTEGRATION.md](docs/QVAC_INTEGRATION.md)**.

## What it does
- **Capture with almost no effort.** Persist-first SMS receiver (at-least-once queue), notification
  actions, one-tap labelling, and a 2-day rule so nothing is silently lost. The inbox backfill starts
  with the newest 60 days and the people you pay most.
- **One definition of money.** Income, spend, fees, cash in/out, own-account transfers, loan draws and
  repayments are distinct. Net counts transfers (money moved to an account we cannot see is money out)
  and excludes loan principal. Every screen uses the same rule.
- **Understand what a payment was.** Item notes and learned unit prices ("cigarette 30", "6 eggs"), habit
  categories, and item/group/label rollups. Habit cards show progress against your own baseline, what came
  before, and opt-in moment nudges; experiments report an interval, never a promise.
- **Plan.** Free float and safe-to-spend, days to zero, expected incomes and outgoing obligations with
  lateness statistics, budgets with pace, savings locations and goals (pots are bookkeeping, not locks).
  Goal modes rearrange the home headline: Steady, Grow, Business or Clarity.
- **Weekly review.** Every Sunday at 18:00 (configurable on/off, digest channel) a local review opens:
  habit follow-through, newly gated patterns, spend episodes, credit-funded share and one experiment.
- **Follow-through.** After due dates pass, Plan shows what the plan predicted versus what happened:
  exactly on time, within grace, partial, missed, open-late, value planned vs arrived, and budget pace.
  It is a mirror, not a discipline score; skipped items are not failures.
- **Wrapped, including places.** The month/year summary adds location highlights only when a recent fix was
  captured: most visited spot, most spent at one place, coverage (n of total), and the top three coarse
  ~110 m clusters. No place name is invented and no map provider is called.
- **Safety.** Balance-chain checks for forged or missing messages, reversal-plea and phishing detection,
  an evidence sheet with the message, parsed fields and balance arithmetic, a ledger audit for explained
  breaks, and alerts that never hide behind a quiet-hours setting.
- **Yours.** Encrypted `.pesabak` backups (Argon2id + XChaCha20-Poly1305, recovery code), staged atomic
  restore with undo, app lock, screenshot privacy, and a developer gate for anything destructive.
- **Optional, never required:** a Google Drive backup (not in this build; needs a Google OAuth client)
  and an assistant connection that sends only coarse summaries (k≥5, no names, no message text) after
  showing you the exact bytes. The app is complete without either.

## Repository
```
packages/core/   Pure TypeScript: parsers, money model, tariffs, expected flows, float, budgets,
                 alerts, capture loop, journal, AI validators, assistant payload/pack/egress.
apps/mobile/     Expo / React Native Android app + Kotlin SMS module + QVAC integration.
apps/mobile/qvac Worker bundle and bundling script (reproducible; contains no user data).
tools/           Dev tools (SMS export, parser coverage, public-snapshot exporter).
data/synthetic/  Invented demo corpora. No real messages are in this repository.
docs/            QVAC integration notes for judges.
```

## Build and test
Requirements: Node `^22.21.0 || >=24.9.0`, npm workspaces, Android SDK (API 35), JDK 21. QVAC does not
run on emulators; use a physical arm64 device (Android 12+).

```bash
npm ci --ignore-scripts
npm test                        # core tests
npx tsc --noEmit -p packages/core
cd apps/mobile && npx tsc --noEmit

# Android release build (JS bundle + native)
cd apps/mobile
bash scripts/bundle-qvac.sh           # rebuilds qvac/worker.bundle.js from @qvac/sdk 0.22.0
cd android && ./gradlew assembleLiveRelease     # dev.yako.app
# or a separate seeded demo install:
EXPO_PUBLIC_DEMO=1 ./gradlew assembleDemoRelease # dev.yako.app.demo
# The android/ directory is committed with hand-written native edits (FLAG_SECURE, permissions,
# the SMS module manifest). Do NOT run `expo prebuild` over it: regenerate only in a scratch copy.
```

Device install and the QVAC model setup (More → On-device intelligence; download once, then airplane
mode) are in [docs/QVAC_INTEGRATION.md](docs/QVAC_INTEGRATION.md). 
## Privacy
The ledger is SQLCipher-encrypted; the key is generated on the device and kept in Keystore-backed secure
storage. The capture queue is AES-256-GCM under a non-extractable Keystore key. Personal messages and
one-time codes are discarded before they reach the ledger. Backups are encrypted or absent. The only
network features are the ones listed above, plus map tiles if you open the map. Read [SECURITY.md](SECURITY.md).

## What existed before the event
<!-- FOUNDER: confirm/adjust this paragraph. It must be accurate for the submission. -->
The pre-event baseline included the deterministic ledger core (SMS parsers, balance chain, detectors,
synthetic personas), an Android app with Feed/Review/Analysis/More, SQLCipher storage and a test suite.
During the hackathon the work added the QVAC integration and all four AI features above, the money-model
rewrite, the tariff engine, expected flows/obligations, float/budgets/savings, alerts, the capture loop,
the encrypted backup container and staged restore, the assistant connection with its threat model, this
documentation, and the on-device verification notes. See `git log`.

## Licence
Code: **AGPL-3.0-only** (see LICENSE). Models and third-party components keep their own licences (NOTICE).
The project name, logo and signing keys are trademarks (TRADEMARK.md). Contributions need the CLA in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Honest limits
We tested Laya (a small local classifier) as a gate on this phone and rejected it: on "Ksh 500.00 sent to
Jane" it answered "not money" with p=0.90 and the wrong direction (docs/QVAC_INTEGRATION.md). The shipped
path is Qwen-only extraction with code validation. AfriSLM's card excludes high-stakes/financial use; we
only translate explanations, with numbers masked and verified. No forecast model or TiRex is bundled.
Fuliza's three-day grace clock (per draw vs per episode) is not published; the default is documented.
Google Drive backup is not shipped in this build.
