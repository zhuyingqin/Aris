use super::allowed_external_url;

#[test]
fn external_url_scheme_filter_allows_browser_links() {
    assert!(allowed_external_url("https://example.com/path"));
    assert!(allowed_external_url("http://example.com"));
    assert!(allowed_external_url("mailto:hello@example.com"));
    assert!(allowed_external_url("tel:+15551234567"));
}

#[test]
fn external_url_scheme_filter_blocks_unsafe_links() {
    assert!(!allowed_external_url("javascript:alert(1)"));
    assert!(!allowed_external_url("data:text/html,<script></script>"));
    assert!(!allowed_external_url("/relative/path"));
    assert!(!allowed_external_url("https://example.com/\nnext"));
}
