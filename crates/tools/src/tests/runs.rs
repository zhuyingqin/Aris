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

#[test]
fn concurrent_upserts_never_lose_an_update() {
    let base = scratch("concurrent");
    runs_upsert_at(&base, &json!({ "id": "shared", "status": "queued" })).unwrap();
    let threads: Vec<_> = (0..16)
        .map(|n| {
            let base = base.clone();
            std::thread::spawn(move || {
                for step in 0..5 {
                    // New ids and field updates to one shared record, interleaved.
                    runs_upsert_at(&base, &json!({ "id": format!("run-{n}-{step}") })).unwrap();
                    runs_upsert_at(&base, &json!({ "id": "shared", format!("field{n}"): step })).unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let lib = runs_load_at(&base).unwrap();
    let runs = lib["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 16 * 5 + 1, "every inserted run survives");
    let shared = runs.iter().find(|r| r["id"] == "shared").unwrap();
    for n in 0..16 {
        assert_eq!(shared[format!("field{n}")], 4, "field{n} keeps its last update");
    }
    // No fixed-name temporary is left behind, and the backup is a valid library.
    let dir = runs_path_at(&base).parent().unwrap().to_path_buf();
    let stray: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name != "runs.json" && name != "runs.json.bak")
        .collect();
    assert!(stray.is_empty(), "unexpected files: {stray:?}");
    let backup = std::fs::read(runs_path_at(&base).with_extension("json.bak")).unwrap();
    assert!(serde_json::from_slice::<Value>(&backup).is_ok());
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_damaged_library_never_overwrites_the_good_backup() {
    let base = scratch("damaged");
    runs_upsert_at(&base, &json!({ "id": "run-1", "status": "ok" })).unwrap();
    runs_upsert_at(&base, &json!({ "id": "run-2", "status": "ok" })).unwrap();
    let path = runs_path_at(&base);
    std::fs::write(&path, b"{ half a libr").unwrap();
    // Loading recovers from the backup; saving on top keeps that backup intact.
    let recovered = runs_load_at(&base).unwrap();
    assert_eq!(recovered["runs"].as_array().unwrap().len(), 1, "the backup is the library before run-2");
    runs_upsert_at(&base, &json!({ "id": "run-3" })).unwrap();
    let backup: Value = serde_json::from_slice(&std::fs::read(path.with_extension("json.bak")).unwrap()).unwrap();
    assert_eq!(backup["runs"].as_array().unwrap().len(), 1);
    assert_eq!(runs_load_at(&base).unwrap()["runs"].as_array().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(&base);
}

fn scratch(name: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!("aris-runs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    base
}
