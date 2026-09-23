use crate::{
    now,
    store::{ComputeAccount, User},
    App,
};
use serde_json::{json, Value};

const TOKEN_NAME: &str = "somniq-account-service";

pub async fn data(response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err("compute service request failed".into());
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "invalid compute service response")?;
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(
            "compute service rejected request; existing users may need account linking".into(),
        );
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

pub fn endpoint(app: &App, path: &str) -> String {
    app.config.newapi_url.join(path).unwrap().to_string()
}

pub async fn start(app: &App) -> Result<String, String> {
    let body = data(
        app.client
            .post(endpoint(app, "api/oauth/state"))
            .json(&json!({"provider":"oidc","intent":"login"}))
            .send()
            .await
            .map_err(|_| "compute service unavailable")?,
    )
    .await?;
    body.get("flow_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or("compute login flow missing".into())
}

fn refresh_cookie(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .find(|v| v.starts_with("new_api_refresh=") && v.len() > 16)
        .map(str::to_string)
}

async fn bundle(
    response: reqwest::Response,
    previous: Option<&ComputeAccount>,
) -> Result<ComputeAccount, String> {
    let cookie = refresh_cookie(&response)
        .or_else(|| previous.map(|a| a.refresh_cookie.clone()))
        .ok_or("compute refresh credential missing")?;
    let body = data(response).await?;
    let user = &body["user"];
    let user_id = user["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("compute user missing")?;
    let oidc_id = user["oidc_id"]
        .as_str()
        .ok_or("compute identity missing")?
        .to_string();
    let access_token = body["access_token"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("compute session missing")?
        .to_string();
    let session_id = body["session"]["sid"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("compute session id missing")?
        .to_string();
    Ok(ComputeAccount {
        user_id,
        oidc_id,
        access_token,
        refresh_cookie: cookie,
        session_id,
        expires_at: body["access_expires_at"].as_i64().unwrap_or(now() + 600),
        model_key: previous.and_then(|v| v.model_key.clone()),
        model_token_id: previous.and_then(|v| v.model_token_id),
        model_policy_hash: previous.and_then(|v| v.model_policy_hash.clone()),
        policy_checked_at: previous.map(|v| v.policy_checked_at).unwrap_or_default(),
    })
}

pub async fn finish(app: &App, code: &str, state: &str, user: &User) -> Result<(), String> {
    let _lock = app.account_lock(&user.id).await;
    let response = app
        .client
        .get(endpoint(app, "api/oauth/oidc"))
        .query(&[("code", code), ("state", state)])
        .send()
        .await
        .map_err(|_| "compute login unavailable")?;
    let mut account = bundle(response, None).await?;
    if account.oidc_id != user.subject {
        return Err("compute identity does not match signed-in account".into());
    }
    let profile = data(
        app.client
            .get(endpoint(app, "api/user/self"))
            .bearer_auth(&account.access_token)
            .send()
            .await
            .map_err(|_| "compute identity check unavailable")?,
    )
    .await?;
    if profile["id"].as_i64() != Some(account.user_id)
        || profile["oidc_id"].as_str() != Some(user.subject.as_str())
    {
        return Err("compute identity check failed".into());
    }
    // Persist the verified mapping before creating a key: a lost response can
    // be recovered by listing this same user's keys under the per-account lock.
    app.store
        .save_compute(&user.id, &app.config.newapi_instance, &account)?;
    sync_key(app, user, &mut account).await?;
    app.store
        .save_compute(&user.id, &app.config.newapi_instance, &account)
}

async fn find_key_id(app: &App, account: &ComputeAccount) -> Result<Option<i64>, String> {
    let body = data(
        app.client
            .get(endpoint(app, "api/token/search"))
            .bearer_auth(&account.access_token)
            .query(&[("keyword", TOKEN_NAME), ("p", "1"), ("page_size", "100")])
            .send()
            .await
            .map_err(|_| "compute keys unavailable")?,
    )
    .await?;
    let items = body
        .as_array()
        .or_else(|| body.get("items").and_then(Value::as_array))
        .ok_or("invalid compute key list")?;
    let matching: Vec<_> = items
        .iter()
        .filter(|v| v["name"].as_str() == Some(TOKEN_NAME))
        .collect();
    if body["total"].as_i64().is_some_and(|n| n > 100) || matching.len() > 1 {
        return Err("duplicate compute service keys require reconciliation".into());
    }
    Ok(matching.first().and_then(|v| v["id"].as_i64()))
}

async fn token(app: &App, account: &ComputeAccount, id: i64) -> Result<Value, String> {
    let value = data(
        app.client
            .get(endpoint(app, &format!("api/token/{id}")))
            .bearer_auth(&account.access_token)
            .send()
            .await
            .map_err(|_| "compute key unavailable")?,
    )
    .await?;
    if value["id"].as_i64() != Some(id)
        || value["user_id"].as_i64() != Some(account.user_id)
        || value["name"].as_str() != Some(TOKEN_NAME)
        || value["status"].as_i64() != Some(1)
        || !value["expired_time"]
            .as_i64()
            .is_some_and(|t| t == -1 || t > now())
    {
        return Err("compute service key identity or status mismatch".into());
    }
    Ok(value)
}

fn limits_match(value: &Value, models: &[String]) -> bool {
    let mut actual: Vec<_> = value["model_limits"]
        .as_str()
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    actual.sort();
    actual.dedup();
    value["model_limits_enabled"].as_bool() == Some(true)
        && actual == models
        && value["group"].as_str() == Some("")
        && value["cross_group_retry"].as_bool() == Some(false)
}

async fn sync_key(app: &App, user: &User, account: &mut ComputeAccount) -> Result<(), String> {
    let policy = app.store.entitlements(&user.id, now())?;
    let mut id = match account.model_token_id {
        Some(id) => Some(id),
        None => find_key_id(app, account).await?,
    };
    if id.is_none() {
        data(app.client.post(endpoint(app,"api/token/")).bearer_auth(&account.access_token)
            .json(&json!({"name":TOKEN_NAME,"expired_time":-1,"unlimited_quota":true,"remain_quota":0,
                "model_limits_enabled":true,"model_limits":policy.models.join(","),"group":"","cross_group_retry":false}))
            .send().await.map_err(|_|"compute key creation unavailable")?).await?;
        id = find_key_id(app, account).await?;
    }
    let id = id.ok_or("compute key creation pending; retry connection")?;
    let current = token(app, account, id).await?;
    if !limits_match(&current, &policy.models) {
        // Our service keys delegate the budget to the user's New API wallet.
        // Refuse a manually imposed finite token cap: read/modify/write could
        // restore quota spent by an in-flight request.
        if current["unlimited_quota"].as_bool() != Some(true) || !current["remain_quota"].is_i64() {
            return Err("compute service key quota configuration requires reconciliation".into());
        }
        let payload = json!({"id":id,"name":TOKEN_NAME,"expired_time":current["expired_time"],
            "remain_quota":current["remain_quota"],"unlimited_quota":current["unlimited_quota"],
            "allow_ips":current["allow_ips"],"model_limits_enabled":true,
            "model_limits":policy.models.join(","),"group":"","cross_group_retry":false});
        data(
            app.client
                .put(endpoint(app, "api/token/"))
                .bearer_auth(&account.access_token)
                .json(&payload)
                .send()
                .await
                .map_err(|_| "compute policy update unavailable")?,
        )
        .await?;
        if !limits_match(&token(app, account, id).await?, &policy.models) {
            return Err("compute policy verification failed".into());
        }
    }
    let body = data(
        app.client
            .post(endpoint(app, &format!("api/token/{id}/key")))
            .bearer_auth(&account.access_token)
            .send()
            .await
            .map_err(|_| "compute key unavailable")?,
    )
    .await?;
    let key = body["key"]
        .as_str()
        .filter(|s| {
            (16..=256).contains(&s.len())
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or("compute key missing")?;
    // Current New API returns the raw key here; some compatible deployments
    // include the OpenAI bearer prefix. Normalize only in this adapter.
    account.model_key = Some(if key.starts_with("sk-") {
        key.to_string()
    } else {
        format!("sk-{key}")
    });
    account.model_token_id = Some(id);
    account.model_policy_hash = Some(policy.fingerprint());
    account.policy_checked_at = now();
    Ok(())
}

pub async fn session(app: &App, user: &User) -> Result<ComputeAccount, String> {
    let _lock = app.account_lock(&user.id).await;
    session_unlocked(app, user).await
}

async fn session_unlocked(app: &App, user: &User) -> Result<ComputeAccount, String> {
    let mut account = app
        .store
        .compute(&user.id, &app.config.newapi_instance)?
        .ok_or("compute account not connected")?;
    if account.expires_at <= now() + 60 {
        let response = app
            .client
            .post(endpoint(app, "api/user/auth/refresh"))
            .header(reqwest::header::COOKIE, &account.refresh_cookie)
            .header(reqwest::header::ORIGIN, app.config.origin())
            .header("X-Auth-Session", &account.session_id)
            .send()
            .await
            .map_err(|_| "compute renewal unavailable")?;
        let renewed = bundle(response, Some(&account)).await?;
        if renewed.user_id != account.user_id || renewed.oidc_id != user.subject {
            return Err("compute renewal identity mismatch".into());
        }
        account = renewed;
        app.store
            .save_compute(&user.id, &app.config.newapi_instance, &account)?;
    }
    Ok(account)
}

// Caller holds the policy read lock, preserving ordering with admin changes.
pub async fn model_account(
    app: &App,
    user: &User,
    reconcile: bool,
) -> Result<ComputeAccount, String> {
    let _lock = app.account_lock(&user.id).await;
    let policy = app.store.entitlements(&user.id, now())?;
    let existing = app
        .store
        .compute(&user.id, &app.config.newapi_instance)?
        .ok_or("compute account not connected")?;
    if !reconcile
        && existing.model_key.is_some()
        && existing.model_token_id.is_some()
        && existing.model_policy_hash.as_deref() == Some(policy.fingerprint().as_str())
        && existing.policy_checked_at > now() - 30
    {
        return Ok(existing);
    }
    let mut account = session_unlocked(app, user).await?;
    sync_key(app, user, &mut account).await?;
    app.store
        .save_compute(&user.id, &app.config.newapi_instance, &account)?;
    Ok(account)
}

pub async fn discover_models(app: &App, user: &User) -> Result<Vec<String>, String> {
    let account = session(app, user).await?;
    let value = data(
        app.client
            .get(endpoint(app, "api/user/models"))
            .bearer_auth(&account.access_token)
            .send()
            .await
            .map_err(|_| "model catalog unavailable")?,
    )
    .await?;
    let mut models: Vec<String> = value
        .as_array()
        .ok_or("invalid model catalog")?
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| crate::membership::valid_model(id))
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}
