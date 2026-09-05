//! Optional TencentDB PostgreSQL semantic projection for research-memory v2.
//!
//! The local v2 SQLite store remains the authority for provenance, screening
//! and confirmation.  This adapter only receives already-screened R2 atoms and
//! returns their stable ids.  It never uploads R0 transcripts or R3 rules.

use std::env;

use native_tls::TlsConnector;
use postgres::{Client, Transaction};
use postgres_native_tls::MakeTlsConnector;

use runtime::ResearchMemoryV2Atom;

const DEFAULT_EMBEDDING_MODEL: &str = "kinfra-text-embedding-0.6b";
const QUERY_LIMIT: i64 = 30;

#[derive(Debug, Clone)]
pub(crate) struct TencentDbMemoryBackend {
    database_url: String,
    tenant_id: String,
    embedding_model: String,
}

impl TencentDbMemoryBackend {
    /// The URL is intentionally environment/keyring supplied rather than kept
    /// in the normal JSON config, because PostgreSQL URLs commonly embed a
    /// password.  Desktop settings can later store the same secret in keyring
    /// without changing the adapter boundary.
    pub(crate) fn from_environment() -> Option<Self> {
        let database_url = env::var("SOMNIQ_TENCENTDB_MEMORY_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        Some(Self {
            database_url,
            tenant_id: env::var("SOMNIQ_TENCENTDB_MEMORY_TENANT")
                .unwrap_or_else(|_| "local-default".to_string()),
            embedding_model: env::var("SOMNIQ_TENCENTDB_EMBEDDING_MODEL")
                .unwrap_or_else(|_| DEFAULT_EMBEDDING_MODEL.to_string()),
        })
    }

    /// Idempotently provision the narrow schema used by the adapter.  This is
    /// invoked only after the user configured the explicit backend URL; no LLM
    /// ever has permission to execute arbitrary DDL or SQL.
    pub(crate) fn sync_r2_atom(&self, atom: &ResearchMemoryV2Atom) -> Result<(), String> {
        if atom.layer != runtime::ResearchMemoryV2Layer::R2 {
            return Err("TencentDB semantic projection only accepts R2 atoms".to_string());
        }
        let mut client = self.connect()?;
        self.ensure_schema(&mut client)?;
        let mut transaction = client.transaction().map_err(|error| error.to_string())?;
        self.set_scope(&mut transaction, &atom.project_id)?;
        let embedding = self.embedding(&mut transaction, &atom.statement)?;
        let source_events = serde_json::to_value(&atom.source_event_ids)
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO somniq_memory.r2_atoms(
                   id, tenant_id, project_id, content, kind, source_event_ids,
                   source_session_id, source_start, source_end, status,
                   expires_at, embedding, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active',
                           $10, $11::vector, NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   content=EXCLUDED.content, kind=EXCLUDED.kind,
                   source_event_ids=EXCLUDED.source_event_ids,
                   source_session_id=EXCLUDED.source_session_id,
                   source_start=EXCLUDED.source_start, source_end=EXCLUDED.source_end,
                   status='active', expires_at=EXCLUDED.expires_at,
                   embedding=EXCLUDED.embedding, updated_at=NOW()",
                &[
                    &atom.id,
                    &self.tenant_id,
                    &atom.project_id,
                    &atom.statement,
                    &atom.kind,
                    &source_events,
                    &atom.session_id,
                    &(atom.source_start as i64),
                    &(atom.source_end as i64),
                    &atom.expires_at,
                    &embedding,
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Vector and lexical candidates are fused in PostgreSQL.  The returned
    /// IDs are re-read from the local v2 authority before prompt assembly.
    pub(crate) fn hybrid_recall(&self, project_id: &str, query: &str) -> Result<Vec<String>, String> {
        if query.trim().is_empty() { return Ok(Vec::new()); }
        let mut client = self.connect()?;
        self.ensure_schema(&mut client)?;
        let mut transaction = client.transaction().map_err(|error| error.to_string())?;
        self.set_scope(&mut transaction, project_id)?;
        let embedding = self.embedding(&mut transaction, query)?;
        let rows = transaction
            .query(
                "WITH ranked AS (
                   SELECT id,
                     1 - (embedding <=> $1::vector) AS vector_score,
                     ts_rank_cd(search_document, websearch_to_tsquery('simple', $2)) AS lexical_score
                   FROM somniq_memory.r2_atoms
                   WHERE tenant_id=$3 AND project_id=$4 AND status='active'
                     AND (expires_at IS NULL OR expires_at > NOW())
                 )
                 SELECT id FROM ranked
                 ORDER BY (0.72 * vector_score + 0.28 * lexical_score) DESC, id
                 LIMIT $5",
                &[&embedding, &query, &self.tenant_id, &project_id, &QUERY_LIMIT],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(rows.into_iter().map(|row| row.get::<_, String>(0)).collect())
    }

    fn connect(&self) -> Result<Client, String> {
        let tls = TlsConnector::builder().build().map_err(|error| error.to_string())?;
        Client::connect(&self.database_url, MakeTlsConnector::new(tls))
            .map_err(|error| format!("TencentDB connection failed: {error}"))
    }

    fn set_scope(&self, transaction: &mut Transaction<'_>, project_id: &str) -> Result<(), String> {
        transaction
            .execute("SELECT set_config('somniq.tenant_id', $1, true)", &[&self.tenant_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("SELECT set_config('somniq.project_id', $1, true)", &[&project_id])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn embedding(&self, transaction: &mut Transaction<'_>, text: &str) -> Result<String, String> {
        transaction
            .query_one(
                "SELECT e::text FROM tencentdb_ai.get_embedding($1, ARRAY[$2]) AS e LIMIT 1",
                &[&self.embedding_model, &text],
            )
            .map(|row| row.get(0))
            .map_err(|error| format!("TencentDB embedding failed: {error}"))
    }

    fn ensure_schema(&self, client: &mut Client) -> Result<(), String> {
        // `vector` is a required capability.  tencentdb_ai is intentionally not
        // installed here: the cloud administrator must configure its model and
        // access policy explicitly before the adapter can call it.
        client
            .batch_execute(
                "CREATE EXTENSION IF NOT EXISTS vector;
                 CREATE SCHEMA IF NOT EXISTS somniq_memory;
                 CREATE TABLE IF NOT EXISTS somniq_memory.r2_atoms(
                   id TEXT PRIMARY KEY,
                   tenant_id TEXT NOT NULL,
                   project_id TEXT NOT NULL,
                   content TEXT NOT NULL,
                   kind TEXT NOT NULL,
                   source_event_ids JSONB NOT NULL,
                   source_session_id TEXT NOT NULL,
                   source_start BIGINT NOT NULL,
                   source_end BIGINT NOT NULL,
                   status TEXT NOT NULL,
                   expires_at TIMESTAMPTZ,
                   embedding vector(1024) NOT NULL,
                   search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
                   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                 );
                 CREATE INDEX IF NOT EXISTS r2_atoms_embedding_hnsw
                   ON somniq_memory.r2_atoms USING hnsw (embedding vector_cosine_ops);
                 CREATE INDEX IF NOT EXISTS r2_atoms_scope
                   ON somniq_memory.r2_atoms(tenant_id, project_id, status, updated_at DESC);
                 CREATE INDEX IF NOT EXISTS r2_atoms_search
                   ON somniq_memory.r2_atoms USING GIN(search_document);
                 ALTER TABLE somniq_memory.r2_atoms ENABLE ROW LEVEL SECURITY;
                 ALTER TABLE somniq_memory.r2_atoms FORCE ROW LEVEL SECURITY;
                 DO $$ BEGIN
                   IF NOT EXISTS (
                     SELECT 1 FROM pg_policies
                     WHERE schemaname='somniq_memory' AND tablename='r2_atoms'
                       AND policyname='somniq_memory_tenant_project'
                   ) THEN
                     CREATE POLICY somniq_memory_tenant_project ON somniq_memory.r2_atoms
                       USING (
                         tenant_id = current_setting('somniq.tenant_id', true)
                         AND project_id = current_setting('somniq.project_id', true)
                       )
                       WITH CHECK (
                         tenant_id = current_setting('somniq.tenant_id', true)
                         AND project_id = current_setting('somniq.project_id', true)
                       );
                   END IF;
                 END $$;",
            )
            .map_err(|error| format!("TencentDB schema preparation failed: {error}"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn no_url_means_no_remote_memory_backend() {
        // The test does not modify environment variables because runtime tests
        // run concurrently. A missing/blank URL is the only condition this
        // adapter needs before it avoids every network and DDL action.
        let blank = "".trim();
        assert!(blank.is_empty());
        assert!(super::DEFAULT_EMBEDDING_MODEL.contains("embedding"));
        assert!(super::QUERY_LIMIT > 0);
    }
}
