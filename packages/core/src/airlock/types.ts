/** Airlock (Z2 boundary). SCAFFOLD: types only. See docs/PRIVACY_MODEL.md section 4. */
export interface AirlockConfig {
  /** Minimum bucket size; smaller cells merge into "other" or are suppressed. */
  k: number;
  timeGranularity: "week" | "month";
  amountMode: "sum" | "band";
  /** Optional differential-privacy noise on released counts. */
  noise?: { epsilon: number };
}

export interface AirlockManifest {
  builtAt: number;
  config: AirlockConfig;
  /** Exactly what was written: table, column, row count. Shown to the user as "what could leave my phone". */
  tables: { name: string; columns: string[]; rows: number }[];
  suppressedCells: number;
}
