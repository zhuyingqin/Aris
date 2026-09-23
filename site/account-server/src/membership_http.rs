use crate::{
    http::{self, Error},
    membership::{Entitlements, GrantUpdate, Plan, PlanUpdate},
    newapi, now,
    store::User,
    App,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type Result<T> = std::result::Result<T, Error>;

pub fn is_admin(app: &App, user: &User) -> bool {
    user.issuer == app.config.issuer.as_str() && app.config.admin_subjects.contains(&user.subject)
}
fn admin(app: &App, headers: &HeaderMap) -> Result<User> {
    let (user, _) = http::user(app, headers)?;
    if !is_admin(app, &user) {
        return Err(Error(StatusCode::FORBIDDEN, "admin_required"));
    }
    Ok(user)
}
fn mutation(app: &App, headers: &HeaderMap) -> Result<User> {
    let user = admin(app, headers)?;
    http::origin(app, headers)?;
    http::consented(app, &user)?;
    Ok(user)
}
fn error(code: String) -> Error {
    let status = match code.as_str() {
        "revision_conflict" => StatusCode::CONFLICT,
        "user_not_found" | "plan_not_found" => StatusCode::NOT_FOUND,
        "invalid_model_list"
        | "invalid_default_model"
        | "plan_models_required"
        | "invalid_expiry"
        | "reason_required"
        | "plan_unavailable" => StatusCode::BAD_REQUEST,
        _ => return code.into(),
    };
    let code = match code.as_str() {
        "revision_conflict" => "revision_conflict",
        "user_not_found" => "user_not_found",
        "plan_not_found" => "plan_not_found",
        "invalid_model_list" => "invalid_model_list",
        "invalid_default_model" => "invalid_default_model",
        "plan_models_required" => "plan_models_required",
        "invalid_expiry" => "invalid_expiry",
        "reason_required" => "reason_required",
        _ => "plan_unavailable",
    };
    Error(status, code)
}
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/v2/catalog/plans", get(catalog))
        .route("/v2/account/entitlements", get(entitlements))
        .route("/v2/admin/plans", get(plans))
        .route("/v2/admin/plans/{id}", axum::routing::put(update_plan))
        .route("/v2/admin/models", get(discover))
        .route("/v2/admin/users", get(users))
        .route("/v2/admin/users/{id}/membership", axum::routing::put(grant))
        .route("/v2/admin/users/{id}/sync", post(sync))
        .route("/v2/admin/audit", get(audit))
}
async fn catalog(State(app): State<Arc<App>>) -> Result<Json<Value>> {
    // Prices are configured offers; checkout is deliberately unavailable until
    // payment verification is implemented. Draft models are not advertised.
    let mut plans = app.store.plans()?;
    for plan in &mut plans {
        if !plan.enabled {
            plan.models.clear();
            plan.default_executor = None;
            plan.default_reviewer = None;
        }
    }
    Ok(Json(json!({"plans":plans,"checkout_available":false})))
}
async fn entitlements(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> Result<Json<Entitlements>> {
    let (user, _) = http::user(&app, &headers)?;
    Ok(Json(app.store.entitlements(&user.id, now())?))
}
async fn plans(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Json<Vec<Plan>>> {
    admin(&app, &headers)?;
    Ok(Json(app.store.plans()?))
}
async fn update_plan(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(update): Json<PlanUpdate>,
) -> Result<Json<Plan>> {
    let user = mutation(&app, &headers)?;
    let _guard = app.policy_lock.write().await;
    Ok(Json(
        app.store
            .update_plan(&user.id, &id, update, now())
            .map_err(error)?,
    ))
}
async fn discover(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Json<Value>> {
    let user = admin(&app, &headers)?;
    http::consented(&app, &user)?;
    Ok(Json(
        json!({"models":newapi::discover_models(&app,&user).await?}),
    ))
}
#[derive(Deserialize, Default)]
struct Search {
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: i64,
}
async fn users(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(search): Query<Search>,
) -> Result<Json<Value>> {
    admin(&app, &headers)?;
    if search.q.len() > 200 || !(0..=1000000).contains(&search.offset) {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid_search"));
    }
    Ok(Json(
        json!({"users":app.store.member_users(&search.q,search.offset,now())?}),
    ))
}
async fn grant(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(update): Json<GrantUpdate>,
) -> Result<Json<Entitlements>> {
    let user = mutation(&app, &headers)?;
    let _guard = app.policy_lock.write().await;
    Ok(Json(
        app.store
            .grant_membership(&user.id, &id, update, now())
            .map_err(error)?,
    ))
}
async fn sync(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    mutation(&app, &headers)?;
    // Queue only known accounts; no upstream identity is accepted from clients.
    if app
        .store
        .member_users(&id, 0, now())?
        .iter()
        .all(|u| u["id"].as_str() != Some(&id))
    {
        return Err(Error(StatusCode::NOT_FOUND, "user_not_found"));
    }
    app.store.finish_sync(&id, 0, None)?;
    Ok(StatusCode::ACCEPTED)
}
async fn audit(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Json<Value>> {
    admin(&app, &headers)?;
    Ok(Json(json!({"events":app.store.membership_audit()?})))
}
