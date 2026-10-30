# Contributing

Thank you for helping. This project handles financial data, so the bar for correctness and privacy
is high.

## Before you start
- Read `SECURITY.md` (privacy rules).
- Open an issue before a large change. Small fixes can go straight to a pull request.
- Never include real SMS, names, phone numbers, account numbers, references or keys in issues, tests,
  fixtures, commits or screenshots. Use synthetic data. A PR that contains personal data will be
  closed and the history rewritten.

## Development
- Node `^22.21.0 || >=24.9.0`; npm workspaces. `npm test`, `npx tsc --noEmit -p packages/core`,
  `cd apps/mobile && npx tsc --noEmit`.
- Every behaviour change needs a test at the core level (pure functions) or a recorded device check
  for native paths.
- Deterministic code decides. Model output is untrusted and must pass a validator.
- Do not add analytics, ads, or third-party SDKs that phone home.

## Contributor licence agreement (CLA) — DRAFT for lawyer review
By submitting a contribution you agree that:
1. You have the right to grant the licence below and your contribution is your original work, or you
   have identified third-party material and its licence.
2. You grant the project owner a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
   copyright and patent licence to use, reproduce, modify, distribute, sublicense and **relicense**
   your contribution, including under a commercial licence.
3. You retain copyright in your contribution and may use it elsewhere.
4. The contribution is provided "as is", without warranty.
Sign-off: add `Signed-off-by: Name <email>` to each commit (`git commit -s`) and, for substantial
contributions, comment "I agree to the CLA" on the pull request. This text is a draft and will be
replaced by the final CLA before the first external contribution is merged.
