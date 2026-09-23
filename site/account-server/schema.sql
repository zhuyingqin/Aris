PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
    email TEXT NOT NULL, display_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(issuer, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_users ON sessions(user_id);
CREATE TABLE IF NOT EXISTS flows (
    state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, sealed TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consents (
    user_id TEXT NOT NULL REFERENCES users(id), version TEXT NOT NULL, content_hash TEXT NOT NULL,
    snapshot TEXT NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY(user_id, version, content_hash)
);
CREATE TABLE IF NOT EXISTS compute_accounts (
    user_id TEXT NOT NULL REFERENCES users(id), instance TEXT NOT NULL, newapi_user_id INTEGER NOT NULL,
    sealed TEXT NOT NULL, PRIMARY KEY(user_id,instance), UNIQUE(instance,newapi_user_id)
);
CREATE TABLE IF NOT EXISTS membership_plans (
    id TEXT PRIMARY KEY CHECK(id IN ('go','plus','pro')),
    models TEXT NOT NULL DEFAULT '[]',
    default_executor TEXT, default_reviewer TEXT,
    enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO membership_plans(id) VALUES ('go'),('plus'),('pro');
CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    plan_id TEXT REFERENCES membership_plans(id), expires_at INTEGER,
    revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS membership_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL, target TEXT NOT NULL,
    before_json TEXT NOT NULL, after_json TEXT NOT NULL,
    reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS membership_sync (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    due_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
INSERT OR IGNORE INTO membership_sync(user_id) SELECT user_id FROM compute_accounts;
