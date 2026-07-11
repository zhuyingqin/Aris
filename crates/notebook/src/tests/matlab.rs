use super::*;

#[test]
fn matlab_path_uses_forward_slashes() {
    let p = PathBuf::from(r"C:\Users\x\AppData\Local\Temp\aris-matlab-1");
    assert_eq!(
        matlab_path(&p),
        "C:/Users/x/AppData/Local/Temp/aris-matlab-1"
    );
}

#[test]
fn is_matlab_kernel_is_case_insensitive() {
    assert!(is_matlab_kernel("matlab"));
    assert!(is_matlab_kernel("MATLAB"));
    assert!(!is_matlab_kernel("python3"));
}

#[test]
fn response_parses_partial_fields() {
    let r: MatlabResponse =
        serde_json::from_str(r#"{"stdout":"hi\n","error":"","images":[]}"#).expect("parse");
    assert_eq!(r.stdout, "hi\n");
    assert!(r.error.is_empty());
    assert!(r.images.is_empty());
}
