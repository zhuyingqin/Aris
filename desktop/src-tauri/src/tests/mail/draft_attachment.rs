use super::*;

#[test]
fn safe_filename_strips_paths_and_header_breaks() {
    assert_eq!(safe_filename("../paper.pdf"), "paper.pdf");
    assert_eq!(safe_filename("bad\r\nname.pdf"), "bad__name.pdf");
    assert_eq!(safe_filename("  "), "attachment.bin");
}
