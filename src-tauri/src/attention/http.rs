/// Find the byte offset of the start of the `\r\n\r\n` header terminator.
/// Returns `None` if the terminator has not yet arrived.
pub(crate) fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Parse the `Content-Length` header value from a header block string.
/// Header matching is case-insensitive. Returns `None` if the header is
/// absent or its value is not a valid non-negative integer.
pub(crate) fn parse_content_length(headers: &str) -> Option<usize> {
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
            let val = lower.split_once(':').map(|x| x.1).unwrap_or("").trim();
            return val.parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parse_content_length edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn parse_content_length_normal() {
        assert_eq!(parse_content_length("Content-Length: 42\r\n"), Some(42));
    }

    #[test]
    fn parse_content_length_missing() {
        assert_eq!(parse_content_length("Host: localhost\r\n"), None);
    }

    #[test]
    fn parse_content_length_zero() {
        // Parser returns Some(0); handle_connection rejects content_length == 0
        assert_eq!(parse_content_length("Content-Length: 0\r\n"), Some(0));
    }

    #[test]
    fn parse_content_length_at_limit() {
        assert_eq!(parse_content_length("Content-Length: 65536\r\n"), Some(65536));
    }

    #[test]
    fn parse_content_length_over_limit() {
        // Parser accepts it; handle_connection rejects values > 65536
        assert_eq!(parse_content_length("Content-Length: 65537\r\n"), Some(65537));
    }

    #[test]
    fn parse_content_length_non_numeric() {
        assert_eq!(parse_content_length("Content-Length: abc\r\n"), None);
    }

    #[test]
    fn parse_content_length_uppercase_header() {
        assert_eq!(parse_content_length("CONTENT-LENGTH: 100\r\n"), Some(100));
    }

    #[test]
    fn parse_content_length_with_extra_whitespace() {
        // Extra spaces around the value should still parse
        assert_eq!(parse_content_length("Content-Length:   128  \r\n"), Some(128));
    }

    #[test]
    fn parse_content_length_negative_rejected() {
        // Negative values cannot be represented as usize — parser should return None
        assert_eq!(parse_content_length("Content-Length: -1\r\n"), None);
    }

    // -----------------------------------------------------------------------
    // find_header_end edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn find_header_end_normal() {
        let buf = b"GET / HTTP/1.1\r\nHost: x\r\n\r\nBODY";
        // \r\n\r\n starts at byte 23
        assert_eq!(find_header_end(buf), Some(23));
    }

    #[test]
    fn find_header_end_not_found() {
        let buf = b"GET / HTTP/1.1\r\nHost: x\r\n";
        assert_eq!(find_header_end(buf), None);
    }

    #[test]
    fn find_header_end_empty() {
        assert_eq!(find_header_end(b""), None);
    }

    #[test]
    fn find_header_end_at_start() {
        let buf = b"\r\n\r\nBODY";
        assert_eq!(find_header_end(buf), Some(0));
    }
}
