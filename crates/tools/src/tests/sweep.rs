use super::*;

fn spec() -> SweepSpec {
    let mut params = Map::new();
    params.insert("lr".to_string(), json!([0.1, 0.01]));
    SweepSpec {
        notebook: "train.ipynb".to_string(),
        seeds: vec![1, 2],
        params,
        stop_on_error: None,
        timeout_secs: None,
        kernel: None,
    }
}

#[test]
fn grid_is_seeds_times_param_product() {
    let points = expand_grid(&spec()).unwrap();
    // 2 seeds × 2 lr = 4 points, each carrying seed + lr.
    assert_eq!(points.len(), 4);
    for p in &points {
        assert!(p.params.contains_key("seed"));
        assert!(p.params.contains_key("lr"));
    }
    let seeds: Vec<_> = points.iter().filter_map(|p| p.seed).collect();
    assert_eq!(seeds.iter().filter(|s| **s == 1).count(), 2);
}

#[test]
fn empty_seeds_yield_one_unseeded_run_per_combo() {
    let mut s = spec();
    s.seeds.clear();
    let points = expand_grid(&s).unwrap();
    assert_eq!(points.len(), 2);
    assert!(points.iter().all(|p| p.seed.is_none()));
}

#[test]
fn manifest_has_one_job_per_point() {
    let manifest = export_manifest(&spec()).unwrap();
    assert_eq!(manifest.matches("- name: run-").count(), 4);
    assert!(manifest.contains("papermill train.ipynb"));
    assert!(manifest.contains("\"seed\":1") || manifest.contains("\"seed\": 1"));
}
