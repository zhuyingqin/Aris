use crate::{
    crypto::hash,
    store::{db_error, Store, User},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub amount_fen: i64,
    pub currency: &'static str,
    pub billing_period: &'static str,
    pub models: Vec<String>,
    pub default_executor: Option<String>,
    pub default_reviewer: Option<String>,
    pub enabled: bool,
    pub revision: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanUpdate {
    pub models: Vec<String>,
    pub default_executor: Option<String>,
    pub default_reviewer: Option<String>,
    pub enabled: bool,
    pub expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantUpdate {
    pub plan_id: Option<String>,
    pub expires_at: Option<i64>,
    pub expected_revision: i64,
    pub reason: String,
}

#[derive(Clone, Serialize)]
pub struct Entitlements {
    pub plan: Option<Plan>,
    pub expires_at: Option<i64>,
    pub membership_revision: i64,
    pub active: bool,
    pub models: Vec<String>,
    pub default_executor: Option<String>,
    pub default_reviewer: Option<String>,
}

impl Entitlements {
    pub fn fingerprint(&self) -> String {
        // Include both revisions: even a revoke/regrant with identical models
        // must not re-use an authorization snapshot from the previous grant.
        hash(
            &json!([
                self.membership_revision,
                self.plan.as_ref().map(|p| p.revision),
                self.expires_at,
                self.active,
                self.models
            ])
            .to_string(),
        )
    }
}

pub fn valid_model(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_/.:".contains(&b))
}

fn read_plans(db: &Connection) -> Result<Vec<Plan>, String> {
    let mut statement = db.prepare("SELECT id,models,default_executor,default_reviewer,enabled,revision FROM membership_plans ORDER BY CASE id WHEN 'go' THEN 1 WHEN 'plus' THEN 2 ELSE 3 END").map_err(db_error)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(db_error)?;
    rows.map(|row| {
        let (id, models, default_executor, default_reviewer, enabled, revision) =
            row.map_err(db_error)?;
        let (name, amount_fen) = match id.as_str() {
            "go" => ("Go", 2900),
            "plus" => ("Plus", 4900),
            "pro" => ("Pro", 9900),
            _ => return Err("invalid stored plan".into()),
        };
        Ok(Plan {
            id,
            name: name.into(),
            amount_fen,
            currency: "CNY",
            billing_period: "month",
            models: serde_json::from_str(&models).map_err(|_| "invalid stored models")?,
            default_executor,
            default_reviewer,
            enabled,
            revision,
        })
    })
    .collect()
}

fn entitlement(db: &Connection, user: &str, now: i64) -> Result<Entitlements, String> {
    let assignment: Option<(Option<String>, Option<i64>, i64)> = db
        .query_row(
            "SELECT plan_id,expires_at,revision FROM memberships WHERE user_id=?1",
            [user],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db_error)?;
    let (id, expires_at, membership_revision) = assignment.unwrap_or((None, None, 0));
    let plan = read_plans(db)?
        .into_iter()
        .find(|p| Some(&p.id) == id.as_ref());
    let account_active: bool = db
        .query_row("SELECT active FROM users WHERE id=?1", [user], |r| r.get(0))
        .map_err(db_error)?;
    let active = account_active
        && expires_at.is_some_and(|t| t > now)
        && plan.as_ref().is_some_and(|p| p.enabled);
    Ok(Entitlements {
        models: plan
            .as_ref()
            .filter(|_| active)
            .map(|p| p.models.clone())
            .unwrap_or_default(),
        default_executor: plan
            .as_ref()
            .filter(|_| active)
            .and_then(|p| p.default_executor.clone()),
        default_reviewer: plan
            .as_ref()
            .filter(|_| active)
            .and_then(|p| p.default_reviewer.clone()),
        plan,
        expires_at,
        membership_revision,
        active,
    })
}

fn audit(
    db: &Connection,
    actor: &str,
    action: &str,
    target: &str,
    change: (&Value, &Value),
    reason: &str,
    now: i64,
) -> Result<(), String> {
    db.execute("INSERT INTO membership_audit(actor_id,action,target,before_json,after_json,reason,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![actor,action,target,change.0.to_string(),change.1.to_string(),reason,now]).map_err(db_error)?;
    Ok(())
}

impl Store {
    pub fn plans(&self) -> Result<Vec<Plan>, String> {
        read_plans(&*self.db()?)
    }
    pub fn entitlements(&self, user: &str, now: i64) -> Result<Entitlements, String> {
        entitlement(&*self.db()?, user, now)
    }

    pub fn update_plan(
        &self,
        actor: &str,
        id: &str,
        mut update: PlanUpdate,
        now: i64,
    ) -> Result<Plan, String> {
        if update.models.len() > 128 || update.models.iter().any(|m| !valid_model(m)) {
            return Err("invalid_model_list".into());
        }
        update.models.sort();
        update.models.dedup();
        for model in [&update.default_executor, &update.default_reviewer]
            .into_iter()
            .flatten()
        {
            if !update.models.contains(model) {
                return Err("invalid_default_model".into());
            }
        }
        if update.enabled
            && (update.models.is_empty()
                || update.default_executor.is_none()
                || update.default_reviewer.is_none())
        {
            return Err("plan_models_required".into());
        }
        let mut db = self.db()?;
        let tx = db.transaction().map_err(db_error)?;
        let before = read_plans(&tx)?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("plan_not_found")?;
        if before.revision != update.expected_revision {
            return Err("revision_conflict".into());
        }
        tx.execute("UPDATE membership_plans SET models=?1,default_executor=?2,default_reviewer=?3,enabled=?4,revision=revision+1 WHERE id=?5",
            params![json!(update.models).to_string(),update.default_executor,update.default_reviewer,update.enabled,id]).map_err(db_error)?;
        tx.execute("INSERT INTO membership_sync(user_id,due_at) SELECT c.user_id,0 FROM compute_accounts c JOIN memberships m ON m.user_id=c.user_id WHERE m.plan_id=?1 ON CONFLICT(user_id) DO UPDATE SET due_at=0", [id]).map_err(db_error)?;
        let after = read_plans(&tx)?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("plan_not_found")?;
        audit(
            &tx,
            actor,
            "plan.updated",
            id,
            (&json!(before), &json!(after)),
            "",
            now,
        )?;
        tx.commit().map_err(db_error)?;
        Ok(after)
    }

    pub fn grant_membership(
        &self,
        actor: &str,
        user: &str,
        update: GrantUpdate,
        now: i64,
    ) -> Result<Entitlements, String> {
        if update.reason.trim().is_empty() || update.reason.len() > 500 {
            return Err("reason_required".into());
        }
        if update.plan_id.is_some() != update.expires_at.is_some()
            || update
                .expires_at
                .is_some_and(|t| t <= now || t > now + 10 * 366 * 86400)
        {
            return Err("invalid_expiry".into());
        }
        let mut db = self.db()?;
        let tx = db.transaction().map_err(db_error)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND active=1)",
                [user],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("user_not_found".into());
        }
        if let Some(id) = &update.plan_id {
            if !read_plans(&tx)?.iter().any(|p| &p.id == id && p.enabled) {
                return Err("plan_unavailable".into());
            }
        }
        let before = entitlement(&tx, user, now)?;
        if before.membership_revision != update.expected_revision {
            return Err("revision_conflict".into());
        }
        tx.execute("INSERT INTO memberships(user_id,plan_id,expires_at,revision,updated_at) VALUES(?1,?2,?3,1,?4) ON CONFLICT(user_id) DO UPDATE SET plan_id=excluded.plan_id,expires_at=excluded.expires_at,revision=memberships.revision+1,updated_at=excluded.updated_at",
            params![user,update.plan_id,update.expires_at,now]).map_err(db_error)?;
        tx.execute("INSERT INTO membership_sync(user_id,due_at) VALUES(?1,0) ON CONFLICT(user_id) DO UPDATE SET due_at=0", [user]).map_err(db_error)?;
        let after = entitlement(&tx, user, now)?;
        audit(
            &tx,
            actor,
            "membership.updated",
            user,
            (&json!(before), &json!(after)),
            update.reason.trim(),
            now,
        )?;
        tx.commit().map_err(db_error)?;
        Ok(after)
    }

    pub fn member_users(&self, query: &str, offset: i64, now: i64) -> Result<Vec<Value>, String> {
        let db = self.db()?;
        let mut stmt = db.prepare("SELECT id,email,display_name,active FROM users WHERE instr(lower(email),lower(?1))>0 OR instr(id,?1)>0 OR instr(lower(display_name),lower(?1))>0 ORDER BY id LIMIT 50 OFFSET ?2").map_err(db_error)?;
        let users = stmt
            .query_map(params![query, offset], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })
            .map_err(db_error)?;
        users
            .map(|row| {
                let (id, email, name, active) = row.map_err(db_error)?;
                let sync: Option<(i64, Option<String>)> = db
                    .query_row(
                        "SELECT due_at,last_error FROM membership_sync WHERE user_id=?1",
                        [&id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(db_error)?;
                Ok(
                    json!({"id":id,"email":email,"display_name":name,"active":active,
                "entitlements":entitlement(&db,&id,now)?,
                "sync_error":sync.as_ref().and_then(|s| s.1.clone())}),
                )
            })
            .collect()
    }

    pub fn membership_audit(&self) -> Result<Vec<Value>, String> {
        let db = self.db()?;
        let mut stmt = db.prepare("SELECT a.id,a.actor_id,u.email,a.action,a.target,a.before_json,a.after_json,a.reason,a.created_at FROM membership_audit a JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100").map_err(db_error)?;
        let rows = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,i64>(0)?,"actor_id":r.get::<_,String>(1)?,"actor_email":r.get::<_,String>(2)?,"action":r.get::<_,String>(3)?,"target":r.get::<_,String>(4)?,"before":r.get::<_,String>(5)?,"after":r.get::<_,String>(6)?,"reason":r.get::<_,String>(7)?,"created_at":r.get::<_,i64>(8)?}))).map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn pending_sync(&self, instance: &str, now: i64) -> Result<Vec<User>, String> {
        let db = self.db()?;
        let mut stmt = db.prepare("SELECT u.id,u.issuer,u.subject,u.email,u.display_name FROM membership_sync s JOIN users u ON u.id=s.user_id JOIN compute_accounts c ON c.user_id=u.id WHERE s.due_at<=?1 AND c.instance=?2 ORDER BY s.due_at,u.id LIMIT 20").map_err(db_error)?;
        let rows = stmt
            .query_map(params![now, instance], |r| {
                Ok(User {
                    id: r.get(0)?,
                    issuer: r.get(1)?,
                    subject: r.get(2)?,
                    email: r.get(3)?,
                    display_name: r.get(4)?,
                })
            })
            .map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn finish_sync(&self, user: &str, due: i64, error: Option<&str>) -> Result<(), String> {
        self.db()?
            .execute(
                "UPDATE membership_sync SET due_at=?1,last_error=?2 WHERE user_id=?3",
                params![due, error, user],
            )
            .map_err(db_error)?;
        Ok(())
    }
}
