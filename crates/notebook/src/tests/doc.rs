use super::*;

#[test]
fn inject_parameters_lands_after_the_parameters_cell() {
    let mut doc = NotebookDoc::new_empty();
    // A tagged `parameters` cell with defaults, then a body cell.
    let cell = new_tagged_code_cell("seed = 0\nlr = 0.1", PARAMETERS_TAG).unwrap();
    doc.cells_mut().push(cell);
    doc.append("code", "print(seed)").unwrap();
    assert_eq!(doc.find_parameters_cell(), Some(0));

    let mut params = serde_json::Map::new();
    params.insert("seed".into(), json!(7));
    params.insert("name".into(), json!("run-a"));
    params.insert("flag".into(), json!(true));
    let at = doc.inject_parameters(&params).unwrap();
    assert_eq!(at, Some(1), "injected cell goes right after parameters");
    assert_eq!(doc.len(), 3);

    let injected = doc.cell_source(1).unwrap();
    assert!(injected.contains("seed = 7"), "got: {injected}");
    assert!(injected.contains("name = \"run-a\""), "got: {injected}");
    assert!(injected.contains("flag = True"), "got: {injected}");
    assert!(cell_has_tag(doc.cells().get(1).unwrap(), INJECTED_TAG));
}

#[test]
fn inject_parameters_renders_matlab_for_matlab_notebooks() {
    let mut doc = NotebookDoc::new_empty();
    doc.set_kernelspec("matlab", "MATLAB", "matlab");
    doc.append("code", "disp(seed)").unwrap();
    assert_eq!(doc.kernelspec_name().as_deref(), Some("matlab"));

    let mut params = serde_json::Map::new();
    params.insert("seed".into(), json!(7));
    params.insert("name".into(), json!("run-a"));
    params.insert("flag".into(), json!(true));
    params.insert("lrs".into(), json!([0.1, 0.01]));
    let at = doc.inject_parameters(&params).unwrap();
    assert_eq!(at, Some(0));

    let injected = doc.cell_source(0).unwrap();
    assert!(
        injected.contains("% Parameters injected by Aris"),
        "got: {injected}"
    );
    assert!(injected.contains("seed = 7;"), "got: {injected}");
    assert!(injected.contains("name = 'run-a';"), "got: {injected}");
    assert!(injected.contains("flag = true;"), "got: {injected}");
    assert!(injected.contains("lrs = [0.1, 0.01];"), "got: {injected}");
    // No Python literals leaked in.
    assert!(!injected.contains("True"), "got: {injected}");
}

#[test]
fn inject_parameters_without_tag_goes_to_top_and_empty_is_noop() {
    let mut doc = NotebookDoc::new_empty();
    doc.append("code", "x = 1").unwrap();
    let mut params = serde_json::Map::new();
    params.insert("x".into(), json!(99));
    assert_eq!(doc.inject_parameters(&params).unwrap(), Some(0));
    assert!(doc.cell_source(0).unwrap().contains("x = 99"));

    // Empty params injects nothing.
    let mut doc2 = NotebookDoc::new_empty();
    doc2.append("code", "pass").unwrap();
    assert_eq!(
        doc2.inject_parameters(&serde_json::Map::new()).unwrap(),
        None
    );
    assert_eq!(doc2.len(), 1);
}
