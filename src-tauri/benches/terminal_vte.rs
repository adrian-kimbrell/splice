use criterion::{black_box, criterion_group, criterion_main, Criterion};
use splice_lib::terminal::term::Emulator;

fn make_emulator() -> Emulator {
    Emulator::new(80, 24, 10000)
}

/// 4KB of plain ASCII text, no escape sequences.
fn plain_text_4k() -> Vec<u8> {
    let line = b"Hello, world! This is plain ASCII terminal output without any escapes.\r\n";
    let mut out = Vec::with_capacity(4096);
    while out.len() < 4096 {
        let remaining = 4096 - out.len();
        let chunk = &line[..line.len().min(remaining)];
        out.extend_from_slice(chunk);
    }
    out
}

/// Dense SGR color codes: 16-color, 256-color, and truecolor.
fn ansi_colors_payload() -> Vec<u8> {
    let mut out = Vec::new();
    // Cycle through standard 16 colors
    for i in 0..16u8 {
        let fg = 30 + (i % 8);
        let bg = 40 + (i % 8);
        out.extend_from_slice(format!("\x1b[{};{}mABC\x1b[0m", fg, bg).as_bytes());
    }
    // 256-color sequences
    for i in (0u16..256).step_by(16) {
        out.extend_from_slice(format!("\x1b[38;5;{}mX\x1b[0m", i).as_bytes());
        out.extend_from_slice(format!("\x1b[48;5;{}mY\x1b[0m", i).as_bytes());
    }
    // Truecolor sequences
    for i in 0..32u8 {
        let r = i.wrapping_mul(8);
        let g = i.wrapping_mul(4);
        let b = i.wrapping_mul(6);
        out.extend_from_slice(
            format!("\x1b[38;2;{};{};{}mZ\x1b[0m", r, g, b).as_bytes(),
        );
    }
    // Repeat to make it substantial
    let base = out.clone();
    while out.len() < 4096 {
        let remaining = 4096 - out.len();
        let chunk = &base[..base.len().min(remaining)];
        out.extend_from_slice(chunk);
    }
    out
}

/// Cursor movement sequences: CUP, CUF, CUB, CUU, CUD.
fn cursor_movement_payload() -> Vec<u8> {
    let mut out = Vec::new();
    for row in 1u16..=24 {
        for col in 1u16..=80 {
            // Absolute position
            out.extend_from_slice(format!("\x1b[{};{}H", row, col).as_bytes());
        }
    }
    // Relative movements
    for _ in 0..64 {
        out.extend_from_slice(b"\x1b[5C"); // CUF 5
        out.extend_from_slice(b"\x1b[3D"); // CUB 3
        out.extend_from_slice(b"\x1b[2B"); // CUD 2
        out.extend_from_slice(b"\x1b[1A"); // CUU 1
    }
    out
}

/// Realistic shell output: prompt + ls -la style output.
fn mixed_output_payload() -> Vec<u8> {
    let mut out = Vec::new();
    // Simulated prompt
    out.extend_from_slice(b"\x1b[1;32muser@host\x1b[0m:\x1b[1;34m~/projects\x1b[0m$ ");
    out.extend_from_slice(b"ls -la\r\n");
    // Simulated ls output
    let entries = [
        "drwxr-xr-x  12 user  staff   384 Jan 15 10:30 .",
        "drwxr-xr-x   8 user  staff   256 Jan 14 09:15 ..",
        "-rw-r--r--   1 user  staff  1234 Jan 15 10:28 Cargo.toml",
        "-rw-r--r--   1 user  staff  5678 Jan 15 10:30 Cargo.lock",
        "drwxr-xr-x   4 user  staff   128 Jan 13 14:22 src",
        "drwxr-xr-x   3 user  staff    96 Jan 13 14:22 benches",
        "-rw-r--r--   1 user  staff   890 Jan 15 09:00 README.md",
        "-rwxr-xr-x   1 user  staff  2048 Jan 15 10:25 build.sh",
    ];
    for entry in &entries {
        out.extend_from_slice(entry.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    // Another prompt
    out.extend_from_slice(b"\x1b[1;32muser@host\x1b[0m:\x1b[1;34m~/projects\x1b[0m$ ");
    // Repeat to fill ~4KB
    let base = out.clone();
    while out.len() < 4096 {
        let remaining = 4096 - out.len();
        let chunk = &base[..base.len().min(remaining)];
        out.extend_from_slice(chunk);
    }
    out
}

/// 64KB bracketed paste simulation.
fn large_paste_payload() -> Vec<u8> {
    let mut out = Vec::new();
    // Bracketed paste start
    out.extend_from_slice(b"\x1b[?2004h"); // enable bracketed paste mode (processed by emulator)
    out.extend_from_slice(b"\x1b[200~");    // paste start marker
    // 64KB of content
    let line = b"This is a line of pasted text that represents typical code content.\n";
    while out.len() < 64 * 1024 {
        let remaining = 64 * 1024 - out.len();
        let chunk = &line[..line.len().min(remaining)];
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(b"\x1b[201~"); // paste end marker
    out
}

fn bench_plain_text(c: &mut Criterion) {
    let payload = plain_text_4k();
    c.bench_function("vte_plain_text_4k", |b| {
        b.iter_with_setup(
            make_emulator,
            |mut emu| {
                emu.advance(black_box(&payload));
                emu
            },
        );
    });
}

fn bench_ansi_colors(c: &mut Criterion) {
    let payload = ansi_colors_payload();
    c.bench_function("vte_ansi_colors", |b| {
        b.iter_with_setup(
            make_emulator,
            |mut emu| {
                emu.advance(black_box(&payload));
                emu
            },
        );
    });
}

fn bench_cursor_movement(c: &mut Criterion) {
    let payload = cursor_movement_payload();
    c.bench_function("vte_cursor_movement", |b| {
        b.iter_with_setup(
            make_emulator,
            |mut emu| {
                emu.advance(black_box(&payload));
                emu
            },
        );
    });
}

fn bench_mixed_output(c: &mut Criterion) {
    let payload = mixed_output_payload();
    c.bench_function("vte_mixed_output", |b| {
        b.iter_with_setup(
            make_emulator,
            |mut emu| {
                emu.advance(black_box(&payload));
                emu
            },
        );
    });
}

fn bench_large_paste(c: &mut Criterion) {
    let payload = large_paste_payload();
    c.bench_function("vte_large_paste_64k", |b| {
        b.iter_with_setup(
            make_emulator,
            |mut emu| {
                emu.advance(black_box(&payload));
                emu
            },
        );
    });
}

criterion_group!(
    benches,
    bench_plain_text,
    bench_ansi_colors,
    bench_cursor_movement,
    bench_mixed_output,
    bench_large_paste,
);
criterion_main!(benches);
