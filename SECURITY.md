# Security policy

Pesanalysis reads sensitive financial SMS and keeps the ledger on the device. We take reports
seriously and will not retaliate for good-faith research.

## Reporting
Email the maintainer at the address in the repository profile, or open a private security advisory
on the hosting platform. Do not file public issues for vulnerabilities. Include: affected version
(commit or APK hash), device/OS, steps to reproduce, impact, and any proof of concept with **no real
personal data**. We aim to acknowledge within 72 hours and to ship a fix or mitigation within 30 days
for confirmed issues.

## Scope
- The Android app (`apps/mobile`), the deterministic core (`packages/core`), the SMS bridge
  (`apps/mobile/modules/yako-sms`), and the QVAC integration (`apps/mobile/src/qvac.ts`, `src/ai`).
- Out of scope: vulnerabilities in third-party models' training data or outputs that cannot change
  the ledger; physical attacks with an unlocked device; issues requiring a rooted device unless they
  defeat at-rest encryption; social engineering.
- We never ask for your passphrase, recovery code, SMS content, or ledger.

## Handling of secrets in reports
Do not include real SMS, account numbers, phone numbers, transaction references, or keys. Redact
them. If a proof of concept needs real-shaped data, generate synthetic messages.

## Cryptography
- Database: SQLCipher with a 256-bit random key stored in Android Keystore-backed secure storage.
- Backups: `.pesabak` container — XChaCha20-Poly1305 chunks, Argon2id passphrase slot, 160-bit
  recovery-code slot (HKDF), authenticated header, per-chunk binding to index and final flag
  (`packages/core/src/backup/container.ts`).
- The SMS capture queue is AES-256-GCM under a non-extractable Android Keystore key.
