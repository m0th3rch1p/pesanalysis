/**
 * Analyst eval harness. SCAFFOLD, not runnable.
 * Will: load question set (tools/eval/questions/*.jsonl, synthetic personas + founder gold under data/private),
 * run planner via an InferenceBackend, validate plans, execute, check numbers with numbersVerified,
 * write a dated row to docs/eval-latest.md. Spike S1 pass criterion: >= 85% plan exact-match, <= 6 s on the itel.
 * NEVER run on private data in CI or commit its output.
 */
throw new Error("NotImplemented: tools/eval/analyst.ts (see docs/IMPLEMENTATION.md WP5, section 10 S1)");
