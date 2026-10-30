# Training (scaffold)

Nothing here runs yet. Rules (D36): every script MUST call `assertAllowed(manifest, teacherId, "teacherLabelling")` and `assertAllowed(manifest, baseId, "finetuneTarget")` before touching data or weights, and refuse to run if either throws. No training on real ledgers. Training data comes from plan templates (synthetic), validated by executing the plan, optionally augmented by an *allowed* open-weights teacher.

Planned: `plan-data.ts` (synthesise plan/question pairs), `finetune-qvac.ts` (QVAC `finetune()` LoRA SFT on a qwen3 GGUF, `assistantLossOnly: true`), `eval-adapter.ts` (adapter must beat base on held-out plan eval). See docs/IMPLEMENTATION.md section 6.
