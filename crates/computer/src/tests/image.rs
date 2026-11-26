use super::*;

fn solid(width: u32, height: u32, bgra: [u8; 4]) -> Bgra {
    Bgra {
        width,
        height,
        pixels: bgra.repeat((width * height) as usize),
    }
}

/// Left half black, right half white.
fn halves(width: u32, height: u32) -> Bgra {
    let mut pixels = Vec::new();
    for _ in 0..height {
        for x in 0..width {
            pixels.extend_from_slice(if x < width / 2 { &[0, 0, 0, 255] } else { &[255, 255, 255, 255] });
        }
    }
    Bgra {
        width,
        height,
        pixels,
    }
}

#[test]
fn base64_matches_the_rfc_vectors() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
}

#[test]
fn scaling_never_enlarges_and_keeps_the_aspect_ratio() {
    let small = solid(100, 50, [1, 2, 3, 255]);
    let (same, scale) = fit_long_edge(&small, 1568);
    assert_eq!((same.width, same.height, scale), (100, 50, 1.0));

    let big = halves(4000, 2000);
    let (fitted, scale) = fit_long_edge(&big, 1000);
    assert_eq!((fitted.width, fitted.height), (1000, 500));
    assert!((scale - 0.25).abs() < 1e-9);
    // Averaging keeps the two halves apart.
    assert_eq!(&fitted.pixels[0..3], &[0, 0, 0]);
    let last = fitted.pixels.len() - 4;
    assert_eq!(&fitted.pixels[last..last + 3], &[255, 255, 255]);
}

#[test]
fn crop_uses_thousandths_and_clamps_to_the_image() {
    let image = halves(200, 100);
    let right = crop_permille(&image, Region { x: 500, y: 0, width: 500, height: 1000 });
    assert_eq!((right.width, right.height), (100, 100));
    assert!(right.pixels.chunks_exact(4).all(|pixel| pixel[0] == 255));

    let past_the_edge = crop_permille(&image, Region { x: 990, y: 990, width: 900, height: 900 });
    assert_eq!((past_the_edge.width, past_the_edge.height), (2, 1));
}

#[test]
fn unpainted_right_and_bottom_margins_are_trimmed_but_painted_black_stays() {
    // 4×3 painted (opaque black and white), inside a 6×5 zeroed bitmap.
    let mut pixels = vec![0u8; 6 * 5 * 4];
    for y in 0..3 {
        for x in 0..4 {
            let at = (y * 6 + x) * 4;
            let value = if x % 2 == 0 { 0 } else { 255 };
            pixels[at..at + 4].copy_from_slice(&[value, value, value, 255]);
        }
    }
    let trimmed = trim_unrendered(&Bgra { width: 6, height: 5, pixels });
    assert_eq!((trimmed.width, trimmed.height), (4, 3));
    // The painted black column at x=0 survived.
    assert_eq!(&trimmed.pixels[0..4], &[0, 0, 0, 255]);

    let full = halves(8, 4);
    assert_eq!(trim_unrendered(&full), full);
}

#[test]
fn blank_captures_are_recognised() {
    assert!(is_blank(&solid(10, 10, [0, 0, 0, 0])));
    assert!(!is_blank(&halves(10, 10)));
}

#[test]
fn png_output_has_the_signature_and_drops_alpha() {
    let png = to_png(&solid(3, 2, [10, 20, 30, 0])).expect("encodes");
    assert_eq!(&png[0..8], b"\x89PNG\r\n\x1a\n");
    // IHDR colour type 2 = truecolour RGB.
    assert_eq!(png[25], 2);
}
