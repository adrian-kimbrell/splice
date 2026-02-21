use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use splice_lib::terminal::emitter::serialize_grid;
use splice_lib::terminal::grid::Grid;

fn make_filled_grid(cols: u16, rows: u16) -> Grid {
    let mut grid = Grid::new(cols, rows);
    let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for i in 0..(cols as usize * rows as usize) {
        grid.write_char(chars[i % chars.len()] as char);
    }
    grid
}

fn make_scrolled_grid(cols: u16, rows: u16) -> Grid {
    let mut grid = Grid::new(cols, rows);
    // Fill scrollback by writing many lines
    for i in 0..500 {
        for _ in 0..cols {
            grid.write_char(char::from(b'A' + (i % 26) as u8));
        }
        grid.linefeed();
        grid.carriage_return();
    }
    grid
}

fn make_sparse_grid(cols: u16, rows: u16) -> Grid {
    let mut grid = Grid::new(cols, rows);
    // Write only a few characters — mostly blank cells
    grid.write_char('$');
    grid.write_char(' ');
    grid.write_char('_');
    grid
}

fn bench_serialize_80x24(c: &mut Criterion) {
    let grid = make_filled_grid(80, 24);
    c.bench_function("serialize_80x24", |b| {
        b.iter(|| serialize_grid(black_box(&grid), black_box(0)));
    });
}

fn bench_serialize_120x40(c: &mut Criterion) {
    let grid = make_filled_grid(120, 40);
    c.bench_function("serialize_120x40", |b| {
        b.iter(|| serialize_grid(black_box(&grid), black_box(0)));
    });
}

fn bench_serialize_220x50(c: &mut Criterion) {
    let grid = make_filled_grid(220, 50);
    c.bench_function("serialize_220x50", |b| {
        b.iter(|| serialize_grid(black_box(&grid), black_box(0)));
    });
}

fn bench_serialize_scrolled(c: &mut Criterion) {
    let mut group = c.benchmark_group("serialize_scrolled");
    for (cols, rows) in [(80u16, 24u16), (120, 40), (220, 50)] {
        let grid = make_scrolled_grid(cols, rows);
        let scroll_offset = 50i32; // scroll back 50 lines
        group.bench_with_input(
            BenchmarkId::new("grid", format!("{}x{}", cols, rows)),
            &(cols, rows),
            |b, _| {
                b.iter(|| serialize_grid(black_box(&grid), black_box(scroll_offset)));
            },
        );
    }
    group.finish();
}

fn bench_serialize_sparse(c: &mut Criterion) {
    let mut group = c.benchmark_group("serialize_sparse");
    for (cols, rows) in [(80u16, 24u16), (120, 40), (220, 50)] {
        let grid = make_sparse_grid(cols, rows);
        group.bench_with_input(
            BenchmarkId::new("grid", format!("{}x{}", cols, rows)),
            &(cols, rows),
            |b, _| {
                b.iter(|| serialize_grid(black_box(&grid), black_box(0)));
            },
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_serialize_80x24,
    bench_serialize_120x40,
    bench_serialize_220x50,
    bench_serialize_scrolled,
    bench_serialize_sparse,
);
criterion_main!(benches);
