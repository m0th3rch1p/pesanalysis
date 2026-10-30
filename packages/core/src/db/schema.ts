/**
 * Local ledger schema (SQLite; SQLCipher-encrypted on device, key in Android Keystore).
 * Exported as a string so it works unchanged in Node (tests) and Expo (no fs reads).
 * Money = integer cents. Times = epoch ms UTC. Taxonomy is DATA, not code (evolving categories).
 */
export const SCHEMA_VERSION = 10;

const SCHEMA_BASE_SQL = /* sql */ `
PRAGMA foreign_keys = ON;

-- Raw capture. Kept so we can RE-PARSE when parsers improve. Never leaves device.
CREATE TABLE IF NOT EXISTS sms_raw (
  id INTEGER PRIMARY KEY,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  purged_at INTEGER,
  UNIQUE (sender, received_at, body_sha256)
);

-- Roles: seeded (family, staff, supplier, customer, landlord, friend, employer...) + user-created ("other" -> custom).
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_custom INTEGER NOT NULL DEFAULT 0,
  merged_into INTEGER REFERENCES roles(id),          -- consolidation sessions collapse roles; never delete
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counterparties (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,                          -- normalised msisdn/till/paybill, else name
  display_name TEXT,                                 -- user-given or contact-derived
  raw_names TEXT NOT NULL DEFAULT '[]',              -- JSON array of names seen in SMS
  role_id INTEGER REFERENCES roles(id),
  contact_id TEXT,                                   -- Android contact id if matched
  first_seen INTEGER NOT NULL
);

-- Taxonomy is data: evolving, mergeable, versioned by consolidation sessions.
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES labels(id),
  status TEXT NOT NULL DEFAULT 'active',             -- active | merged | retired
  merged_into INTEGER REFERENCES labels(id),
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  name TEXT,                                         -- named only after the user confirms once
  lat REAL NOT NULL, lng REAL NOT NULL, radius_m INTEGER NOT NULL DEFAULT 75,
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS episodes (                -- trip / date / event / operation bundle
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  started_at INTEGER, ended_at INTEGER,
  source TEXT NOT NULL DEFAULT 'user'                -- user | calendar | auto
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  sms_id INTEGER REFERENCES sms_raw(id),
  provider TEXT NOT NULL,
  ref TEXT,                                          -- provider tx id; natural dedupe key
  kind TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount INTEGER NOT NULL,
  fee INTEGER,
  balance_after INTEGER,
  counterparty_id INTEGER REFERENCES counterparties(id),
  account TEXT,
  occurred_at INTEGER NOT NULL,
  template TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  chain_status TEXT NOT NULL DEFAULT 'unknown',      -- ok | break | first | unknown
  chain_discrepancy INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'unknown',             -- personal | business | mixed | unknown
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | auto | confirmed | edited
  episode_id INTEGER REFERENCES episodes(id),
  role TEXT NOT NULL DEFAULT 'transaction',          -- transaction | funding_notice | bank_mirror | duplicate_notice
  event_ref TEXT,                                    -- links messages that describe ONE movement (receipt / telco debt marker)
  account_id INTEGER,                                -- v4: source account node
  settlement_status TEXT NOT NULL DEFAULT 'unknown', -- v4: settled | pending | unsettled | unknown
  UNIQUE (sms_id)
);
CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_tx_cp ON transactions(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_tx_event ON transactions(event_ref);

-- Canonical events only: one row per real movement. Funding notices and mirrors
-- stay in transactions for audit/balance-chain but never hit the ledger or stats.
CREATE VIEW IF NOT EXISTS tx_events AS
  SELECT * FROM transactions WHERE role = 'transaction';

CREATE TABLE IF NOT EXISTS tx_labels (
  tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id),
  source TEXT NOT NULL,                              -- user | rule | knn | llm | frontier
  confidence REAL,
  suggested_at INTEGER NOT NULL,
  confirmed_at INTEGER,                              -- non-null => ground truth for learning + evals
  PRIMARY KEY (tx_id, label_id)
);

-- Free-form enrichment: tags, notes, voice/photo/video. Media files live in app-private storage.
CREATE TABLE IF NOT EXISTS tx_notes (
  id INTEGER PRIMARY KEY,
  tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                -- text | tag | voice | photo | video
  text TEXT,                                         -- note text, tag, or transcript
  uri TEXT,                                          -- file:// in app sandbox
  transcript_lang TEXT, transcript_conf REAL,
  created_at INTEGER NOT NULL
);

-- Context captured at SMS arrival (one coarse fix, motion state, nearby calendar event).
CREATE TABLE IF NOT EXISTS tx_context (
  tx_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  lat REAL, lng REAL, accuracy_m REAL,
  place_id INTEGER REFERENCES places(id),
  motion TEXT,                                       -- still | walking | vehicle | unknown
  steps_last_10m INTEGER,
  calendar_event_id TEXT, calendar_title TEXT,
  source TEXT NOT NULL DEFAULT 'none',               -- sms_receiver | foreground | backfill | synthetic
  captured_at INTEGER,
  age_ms INTEGER,
  battery_pct INTEGER,                               -- v4 passive telemetry
  is_charging INTEGER,
  step_delta INTEGER,
  circadian_phase TEXT                               -- morning | afternoon | evening | late_night
);

-- Detector output (pure code). LLM narrates these; it never creates them.
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, detector TEXT NOT NULL, title TEXT NOT NULL,
  n INTEGER NOT NULL, p_value REAL, evidence TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'new'                  -- new | shown | dismissed | acted
);

-- Evolution loop (ported from the mouse EVOLUTION design): typed, gated, reversible proposals.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,                              -- profiler | local_llm | frontier | user
  type TEXT NOT NULL,                                -- rule_add | rule_edit | label_merge | label_split | role_merge | prompt_delta
  patch TEXT NOT NULL,
  rationale TEXT, predicted TEXT,
  evidence TEXT,                                     -- {n, wins, losses, p, verdict}
  status TEXT NOT NULL DEFAULT 'proposed',           -- proposed | canary | applied | rejected | rolled_back
  created_at INTEGER NOT NULL, applied_at INTEGER, rolled_back_at INTEGER
);

-- Daily/weekly/monthly/yearly consolidation + alignment interviews.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  cadence TEXT NOT NULL,                             -- daily | weekly | monthly | yearly
  period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  summary TEXT, decisions TEXT
);

CREATE TABLE IF NOT EXISTS goals (                   -- budgets / savings / personal-development targets
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  target_cents INTEGER, period TEXT, label_id INTEGER REFERENCES labels(id), created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * v3 (WP1/WP3/WP7): tags + ventures, durable media, full-text search, persisted analyses,
 * analyst conversations, the question queue, a typed world model, and the trust-zone audit.
 * Additive only. FTS5 is created separately (ensureFts) because SQLCipher builds vary.
 */
export const SCHEMA_V3_SQL = /* sql */ `
-- User-created, suggested and retroactive tags. Ventures are tags with a P&L identity.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'user',                  -- user | suggested | auto | venture
  color TEXT,
  parent_id INTEGER REFERENCES tags(id),
  status TEXT NOT NULL DEFAULT 'active',              -- active | merged | archived
  merged_into INTEGER REFERENCES tags(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tx_tags (
  tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  source TEXT NOT NULL DEFAULT 'user',                -- user | rule | cluster | llm
  confidence REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tx_id, tag_id)
);
CREATE TABLE IF NOT EXISTS ventures (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project',               -- project | business | investment | savings_goal | trip | event
  tag_id INTEGER NOT NULL UNIQUE REFERENCES tags(id),
  status TEXT NOT NULL DEFAULT 'active',
  opened_at INTEGER, closed_at INTEGER, notes TEXT
);
CREATE TABLE IF NOT EXISTS tag_rules (
  id INTEGER PRIMARY KEY,
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  match_on TEXT NOT NULL DEFAULT 'counterparty',      -- counterparty | text | template | kind
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Media is app-private; SQLCipher encrypts the DB, not these files (D41).
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                 -- photo | video | voice | document
  uri TEXT NOT NULL,
  mime TEXT, bytes INTEGER, duration_ms INTEGER, width INTEGER, height INTEGER,
  caption TEXT, created_at INTEGER NOT NULL
);

-- Findings become durable (G2): state survives re-runs.
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  data_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                 -- user | assistant | system
  content TEXT NOT NULL,
  plan_json TEXT,
  result_json TEXT,
  numbers_verified INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options_json TEXT,
  why TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',             -- pending | answered | dismissed | expired
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  answer_json TEXT,
  UNIQUE (kind, subject_ref)
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'user',                -- user | inferred | imported
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (subject, predicate, object)
);
CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);

-- Trust zones (D39): paired hosts and every cross-zone read/write.
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT 'Z1',
  key_fingerprint TEXT,
  paired_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS tool_audit (
  id INTEGER PRIMARY KEY,
  zone TEXT NOT NULL,
  host_id TEXT,
  tool TEXT NOT NULL,
  params_json TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  at INTEGER NOT NULL
);

-- Z2 airlock: aggregate cells only, k-suppressed, no counterparties and no free text.
CREATE TABLE IF NOT EXISTS airlock_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS airlock_monthly (
  month TEXT NOT NULL,
  direction TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_band TEXT NOT NULL,
  tx_count INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  PRIMARY KEY (month, direction, label, amount_band)
);
CREATE TABLE IF NOT EXISTS airlock_categories (
  month TEXT NOT NULL,
  label TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  tx_count INTEGER NOT NULL,
  PRIMARY KEY (month, label)
);

CREATE INDEX IF NOT EXISTS idx_notes_tx ON tx_notes(tx_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_role ON transactions(role);
CREATE INDEX IF NOT EXISTS idx_txlabels_label ON tx_labels(label_id);
CREATE INDEX IF NOT EXISTS idx_txlabels_confirmed ON tx_labels(confirmed_at);
CREATE INDEX IF NOT EXISTS idx_tags_tx_tag ON tx_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_attach_tx ON attachments(tx_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status, score);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_period ON sessions(cadence, period_start);
CREATE INDEX IF NOT EXISTS idx_findings_state ON findings(state, last_seen);

-- G5: early builds wrote 'description'; normalise in place.
UPDATE tx_notes SET kind = 'note' WHERE kind IN ('description', 'text', 'caption');
`;

/**
 * v4 (Sovereign Panopticon + Rail Onboarding): auto-discovered account graph,
 * custom templates, security/reconciliation alerts, masked-entity links, and
 * user-started causal experiments.
 */
export const SCHEMA_V4_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,                                -- wallet | bank | card | credit | savings | utility_meter | sacco | vault
  name TEXT NOT NULL,
  sender_id TEXT,
  account_mask TEXT NOT NULL DEFAULT '',
  paybill_or_till TEXT,
  visibility TEXT NOT NULL DEFAULT 'full',           -- full | partial | opaque
  currency TEXT NOT NULL DEFAULT 'KES',
  last_balance_cents INTEGER,
  last_balance_at INTEGER,
  total_in_cents INTEGER NOT NULL DEFAULT 0,
  total_out_cents INTEGER NOT NULL DEFAULT 0,
  tx_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  discovered_via TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider, account_mask)
);
CREATE TABLE IF NOT EXISTS custom_templates (
  id INTEGER PRIMARY KEY,
  sender_pattern TEXT NOT NULL,
  provider TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL,
  body_regex TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  verified_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS security_alerts (
  id INTEGER PRIMARY KEY,
  sms_id INTEGER REFERENCES sms_raw(id),
  tx_id INTEGER REFERENCES transactions(id),
  severity TEXT NOT NULL,                            -- critical | warning | info
  kind TEXT NOT NULL,                                -- msisdn_spoof | balance_break | unsettled_mirror | reversal_trap
  sender TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS entity_links (
  masked_key TEXT NOT NULL,
  full_key TEXT NOT NULL,
  contact_id TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (masked_key, full_key)
);
CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hypothesis TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metric_measure TEXT NOT NULL DEFAULT 'spend',     -- spend | fees | count | net
  target_label TEXT,
  control_label TEXT,
  status TEXT NOT NULL DEFAULT 'running',            -- running | completed | abandoned
  created_at INTEGER NOT NULL,
  result_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider, account_mask);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON security_alerts(resolved_at, occurred_at);
CREATE INDEX IF NOT EXISTS idx_entity_links_masked ON entity_links(masked_key);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status, started_at);
`;

/**
 * v5: Fuliza/credit-line state on accounts, and the local product/warranty registry.
 * Columns are added tolerantly by ensureV5Columns() so partial DBs converge.
 */
export const SCHEMA_V5_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  tx_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  bought_at INTEGER,
  price_cents INTEGER,
  warranty_months INTEGER,
  warranty_ends_at INTEGER,
  image_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',             -- active | retired
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_tx ON products(tx_id);
CREATE INDEX IF NOT EXISTS idx_products_hash ON products(image_hash);
CREATE INDEX IF NOT EXISTS idx_products_warranty ON products(warranty_ends_at);
`;

/**
 * v6: transaction bundles (airtime purchase + credited value), entity-resolution
 * candidates/merges, sticky counterparty defaults, and first-class debt tracking.
 * The canonical view excludes non-cash airtime notices and bundle evidence.
 */
export const SCHEMA_V6_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS tx_bundles (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'airtime',
  primary_tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  received_cents INTEGER NOT NULL DEFAULT 0,
  hidden_fee_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(primary_tx_id)
);
CREATE INDEX IF NOT EXISTS idx_bundles_primary ON tx_bundles(primary_tx_id);

CREATE TABLE IF NOT EXISTS entity_merge_candidates (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'counterparty',
  left_id INTEGER NOT NULL,
  right_id INTEGER NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',             -- pending | accepted | dismissed
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(kind, left_id, right_id)
);
CREATE INDEX IF NOT EXISTS idx_merge_status ON entity_merge_candidates(status, score);

CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  creditor TEXT,
  creditor_phone TEXT,
  kind TEXT NOT NULL DEFAULT 'personal',             -- personal | business | loan | informal | other
  principal_cents INTEGER,
  balance_cents INTEGER,
  interest_rate_bps INTEGER,
  interest_type TEXT NOT NULL DEFAULT 'none',        -- none | simple | compound
  payment_cents INTEGER,
  payment_frequency TEXT NOT NULL DEFAULT 'monthly', -- weekly | biweekly | monthly | oneoff | irregular
  start_at INTEGER,
  next_due_at INTEGER,
  end_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',             -- active | settled | paused
  source TEXT NOT NULL DEFAULT 'manual',             -- manual | contract | web | inferred
  contract_uri TEXT,
  notes TEXT,
  confidence REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status, next_due_at);

CREATE TABLE IF NOT EXISTS debt_links (
  id INTEGER PRIMARY KEY,
  debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'suggested',           -- suggested | user
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending',             -- pending | accepted | dismissed
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(debt_id, tx_id)
);
CREATE INDEX IF NOT EXISTS idx_debt_links_status ON debt_links(status, debt_id);

UPDATE transactions SET role = 'airtime_credit'
 WHERE role = 'transaction' AND kind = 'airtime' AND direction = 'in';
UPDATE transactions SET role = 'airtime_notice'
 WHERE role = 'transaction'
   AND (template LIKE 'airtel.airtime_loan%' OR template LIKE 'airtel.kopa_repay%' OR template LIKE 'telco.okoa_%');

DROP VIEW IF EXISTS tx_events;
CREATE VIEW tx_events AS
  SELECT * FROM transactions
   WHERE role = 'transaction'
     AND NOT (kind = 'airtime' AND direction = 'in')
     AND template NOT LIKE 'airtel.airtime_loan%'
     AND template NOT LIKE 'airtel.kopa_repay%'
     AND template NOT LIKE 'telco.okoa_%';
`;


/**
 * v8 (F-EXPECT, F-SAVINGS, F-BUDGET): expected flows and their occurrences, savings locations and goals,
 * budgets. Additive only. Money = integer cents. Dates are Africa/Nairobi calendar days ("YYYY-MM-DD");
 * `*_ms` columns are epoch ms UTC of the start of that EAT day.
 */
export const SCHEMA_V8_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS expected_flows (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),   -- in = declared income, out = obligation
  name TEXT NOT NULL,
  counterparty_hint TEXT,                            -- normalised substring matched against counterparty/account/template text
  amount_min_cents INTEGER,
  amount_typ_cents INTEGER,
  amount_max_cents INTEGER,
  cadence TEXT NOT NULL CHECK (cadence IN ('once', 'weekly', 'monthly', 'last_working_day', 'custom')),
  day_of_month INTEGER,                              -- monthly: 1..31 (clamped to month length)
  weekday INTEGER,                                   -- weekly: 0 = Sunday .. 6 = Saturday
  interval_days INTEGER,                             -- custom: every N days from anchor_on
  anchor_on TEXT,                                    -- once: the date; custom: first date
  holiday_policy TEXT NOT NULL DEFAULT 'none' CHECK (holiday_policy IN ('none', 'before', 'after')),
  grace_days INTEGER NOT NULL DEFAULT 1,
  missed_after_days INTEGER NOT NULL DEFAULT 7,
  early_days INTEGER NOT NULL DEFAULT 3,             -- how many days before due an arrival still counts
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'sms', 'detected')),
  source_ref TEXT,                                   -- dedupe key for sms/detected flows
  debt_id INTEGER,
  starts_on TEXT,
  ends_on TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suggested', 'paused', 'ended', 'dismissed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_flows_ref ON expected_flows(source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expected_flows_status ON expected_flows(status, direction);

CREATE TABLE IF NOT EXISTS expected_occurrences (
  id INTEGER PRIMARY KEY,
  flow_id INTEGER NOT NULL REFERENCES expected_flows(id) ON DELETE CASCADE,
  nominal_on TEXT NOT NULL,                          -- date before holiday shifting (identity of the occurrence)
  due_on TEXT NOT NULL,                              -- date after shifting
  due_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'upcoming' CHECK (state IN ('upcoming', 'matched', 'late', 'partial', 'missed', 'waived')),
  matched_tx_ids TEXT NOT NULL DEFAULT '[]',         -- JSON array of transactions.id
  pinned_tx_ids TEXT NOT NULL DEFAULT '[]',          -- manual "this is it"; always kept
  rejected_tx_ids TEXT NOT NULL DEFAULT '[]',        -- manual "not this"; never matched
  received_cents INTEGER NOT NULL DEFAULT 0,
  expected_cents INTEGER,                            -- snapshot of the amount that completes this occurrence
  delay_days INTEGER,                                -- signed whole days, first receipt vs due date (negative = early)
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (flow_id, nominal_on)
);
CREATE INDEX IF NOT EXISTS idx_occ_due ON expected_occurrences(due_ms);
CREATE INDEX IF NOT EXISTS idx_occ_state ON expected_occurrences(state, due_ms);

CREATE TABLE IF NOT EXISTS savings_locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rail TEXT NOT NULL CHECK (rail IN ('mshwari', 'kcb_mpesa', 'bank', 'mmf', 'sacco', 'mpesa_pot', 'cash', 'other')),
  is_virtual INTEGER NOT NULL DEFAULT 0,             -- 1 = bookkeeping pot inside the wallet (not a lock)
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_at INTEGER,
  account_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS savings_goals (
  id INTEGER PRIMARY KEY,
  location_id INTEGER REFERENCES savings_locations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  horizon TEXT NOT NULL DEFAULT 'short' CHECK (horizon IN ('short', 'long')),
  target_cents INTEGER NOT NULL,
  saved_cents INTEGER NOT NULL DEFAULT 0,
  target_on TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'paused', 'dropped')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly', 'custom')),
  anchor INTEGER,                                    -- weekly: weekday 0..6 (default 1 = Monday); monthly: day-of-month 1..31 (default 1)
  period_days INTEGER,                               -- custom length
  anchor_on TEXT,                                    -- custom: first period start (EAT date)
  label_id INTEGER REFERENCES labels(id),            -- label scope (includes child labels); both null = total spend
  tag_id INTEGER REFERENCES tags(id),
  limit_cents INTEGER NOT NULL,
  rollover INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * v9 (F-ALERTS, F-REVIEWLOOP, F-JOURNAL): alert log + per-rule prefs/counters, capture prompts, decision journal.
 * Additive only. Money = integer cents; `*_at` = epoch ms; `on_date` = EAT calendar day.
 */
export const SCHEMA_V9_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS alerts_log (
  id INTEGER PRIMARY KEY,
  rule_id TEXT NOT NULL,
  alert_key TEXT NOT NULL,                           -- stable subject id
  dedupe_key TEXT NOT NULL,                          -- one occurrence (subject + period/level)
  severity TEXT NOT NULL CHECK (severity IN ('low', 'normal', 'high', 'safety')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  redacted_body TEXT NOT NULL,
  action_url TEXT,
  subject_ref TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER NOT NULL,
  expires_at INTEGER,
  opened_at INTEGER,
  acted_at INTEGER,
  dismissed_at INTEGER,
  snooze_until INTEGER,
  useful INTEGER CHECK (useful IS NULL OR useful IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_alerts_log_time ON alerts_log(delivered_at);
CREATE INDEX IF NOT EXISTS idx_alerts_log_key ON alerts_log(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_alerts_log_rule ON alerts_log(rule_id, delivered_at);

CREATE TABLE IF NOT EXISTS alert_prefs (
  rule_id TEXT PRIMARY KEY,                          -- '*' = global prefs (quiet hours, caps) in prefs_json
  enabled INTEGER NOT NULL DEFAULT 1,
  snoozed_until INTEGER,
  prefs_json TEXT,
  delivered INTEGER NOT NULL DEFAULT 0,              -- counter-metrics, recomputed from alerts_log
  opened INTEGER NOT NULL DEFAULT 0,
  acted INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  useful_yes INTEGER NOT NULL DEFAULT 0,
  useful_no INTEGER NOT NULL DEFAULT 0,
  demoted INTEGER NOT NULL DEFAULT 0,
  stats_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_prompts (
  id INTEGER PRIMARY KEY,
  tx_id INTEGER NOT NULL UNIQUE,
  tier TEXT NOT NULL CHECK (tier IN ('full', 'single', 'batch', 'none')),
  materiality REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  counterparty_key TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  steps_sent INTEGER NOT NULL DEFAULT 0,
  last_prompt_at INTEGER,
  stale_escalated_at INTEGER,
  snooze_until INTEGER,
  completeness INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('submitted', 'done', 'dismissed'))
);
CREATE INDEX IF NOT EXISTS idx_capture_open ON capture_prompts(resolved_at, created_at);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  decision_text TEXT NOT NULL,
  why TEXT,
  linked_tx_id INTEGER,
  linked_budget_id INTEGER,
  linked_obligation_id INTEGER,
  rule_json TEXT,                                    -- JournalRule, null = manual-only
  baseline_json TEXT,
  started_on TEXT NOT NULL,
  ends_on TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_checks (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  on_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('followed', 'slipped', 'skipped', 'na')),
  source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  evidence_tx_ids TEXT NOT NULL DEFAULT '[]',
  detail TEXT,
  note TEXT,
  checked_at INTEGER NOT NULL,
  UNIQUE (entry_id, on_date)
);
CREATE INDEX IF NOT EXISTS idx_journal_checks_entry ON journal_checks(entry_id, on_date);
`;

/**
 * v10: items, habits, goal modes, capture controls and finding gates (plan 15 §2).
 * Tables are created together because items reference habits and habits reference goal plans.
 */
export const SCHEMA_V10_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS goal_plans (
  id INTEGER PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('steady','grow','business','clarity')),
  title TEXT NOT NULL, kind TEXT NOT NULL,
  params_json TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('reduce','increase','keep')),
  target_json TEXT, baseline_json TEXT, nudge_json TEXT,
  goal_id INTEGER REFERENCES goal_plans(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS item_groups (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  parent_id INTEGER REFERENCES item_groups(id), label_id INTEGER REFERENCES labels(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  key TEXT,                                         -- normalised lookup key (plural-folded)
  group_id INTEGER REFERENCES item_groups(id), habit_id INTEGER REFERENCES habits(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tx_items (
  id INTEGER PRIMARY KEY,
  tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id), group_id INTEGER REFERENCES item_groups(id),
  qty REAL, unit TEXT, amount_cents INTEGER,
  source TEXT NOT NULL CHECK (source IN ('inferred','note','ocr','user','gold')),
  confidence REAL, confirmed_at INTEGER, created_at INTEGER NOT NULL,
  CHECK (item_id IS NOT NULL OR group_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_tx_items_tx ON tx_items(tx_id);
CREATE INDEX IF NOT EXISTS idx_tx_items_item ON tx_items(item_id);
CREATE TABLE IF NOT EXISTS item_prices (
  counterparty_id INTEGER NOT NULL REFERENCES counterparties(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  unit_cents INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY (counterparty_id, item_id, unit_cents)
);
CREATE TABLE IF NOT EXISTS ask_suppress (
  counterparty_id INTEGER PRIMARY KEY REFERENCES counterparties(id), created_at INTEGER NOT NULL
);
`;


export const SCHEMA_SQL = SCHEMA_BASE_SQL + SCHEMA_V3_SQL + SCHEMA_V4_SQL + SCHEMA_V5_SQL + SCHEMA_V6_SQL + SCHEMA_V8_SQL + SCHEMA_V9_SQL + SCHEMA_V10_SQL;

/** Created separately and tolerantly: FTS5 availability under SQLCipher is spike S2. */
export const FTS_SQL = /* sql */ `
CREATE VIRTUAL TABLE IF NOT EXISTS tx_fts USING fts5(
  tx_id UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;
