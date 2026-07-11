use super::*;

#[test]
fn upsert_inserts_then_field_merges_by_id() {
    let base = std::env::temp_dir().join(format!("aris-runs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);

    // Empty library when nothing on disk.
    assert_eq!(runs_load_at(&base).unwrap(), empty_runs());

    // Insert a new run.
    let r = json!({ "id": "run-1", "sourceNotebook": "a.ipynb", "status": "running", "backend": "local" });
    runs_upsert_at(&base, &r).unwrap();
    let lib = runs_load_at(&base).unwrap();
    assert_eq!(lib["runs"].as_array().unwrap().len(), 1);
    assert_eq!(lib["runs"][0]["status"], "running");

    // Partial update merges onto the same id (sourceNotebook preserved).
    let upd = json!({ "id": "run-1", "status": "ok", "metrics": { "acc": 0.9 } });
    let merged = runs_upsert_at(&base, &upd).unwrap();
    assert_eq!(merged["status"], "ok");
    assert_eq!(merged["sourceNotebook"], "a.ipynb");
    assert_eq!(merged["metrics"]["acc"], 0.9);

    let lib = runs_load_at(&base).unwrap();
    assert_eq!(
        lib["runs"].as_array().unwrap().len(),
        1,
        "same id must not duplicate"
    );

    // A second id inserts at the front.
    runs_upsert_at(&base, &json!({ "id": "run-2", "sourceNotebook": "b.ipynb", "status": "queued", "backend": "local" })).unwrap();
    let lib = runs_load_at(&base).unwrap();
    assert_eq!(lib["runs"][0]["id"], "run-2");
    assert_eq!(lib["runs"].as_array().unwrap().len(), 2);

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn record_builder_round_trips() {
    let mut rec = RunRecord::new_local("nb.ipynb");
    rec.seed = Some(7);
    rec.status = "ok".to_string();
    let v = rec.to_value();
    assert_eq!(v["sourceNotebook"], "nb.ipynb");
    assert_eq!(v["seed"], 7);
    assert!(v.get("id").is_some());
}
