use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use splice_lib::terminal::grid::Grid;

fn make_grid(cols: u16, rows: u16) -> Grid {
    Grid::new(cols, rows, 10000)
}

fn bench_write_char_line(c: &mut Criterion) {
    let mut group = c.benchmark_group("write_char_line");
    for (cols, rows) in [(80u16, 24u16), (120, 40), (220, 50)] {
        group.bench_with_input(
            BenchmarkId::new("grid", format!("{}x{}", cols, rows)),
            &(cols, rows),
            |b, &(cols, rows)| {
                b.iter_with_setup(
                    || make_grid(cols, rows),
                    |mut grid| {
                        for _ in 0..cols {
                            grid.write_char(black_box('A'));
                        }
                        grid
                    },
                );
            },
        );
    }
    group.finish();
}

fn bench_write_char_fill(c: &mut Criterion) {
    let mut group = c.benchmark_group("write_char_fill");
    for (cols, rows) in [(80u16, 24u16), (120, 40), (220, 50)] {
        group.bench_with_input(
            BenchmarkId::new("grid", format!("{}x{}", cols, rows)),
            &(cols, rows),
            |b, &(cols, rows)| {
                b.iter_with_setup(
                    || make_grid(cols, rows),
                    |mut grid| {
                        for _ in 0..(cols as usize * rows as usize) {
                            grid.write_char(black_box('A'));
                        }
                        grid
                    },
                );
            },
        );
    }
    group.finish();
}

fn bench_scroll_up(c: &mut Criterion) {
    let mut group = c.benchmark_group("scroll_up");
    for (cols, rows) in [(80u16, 24u16), (120, 40), (220, 50)] {
        group.bench_with_input(
            BenchmarkId::new("grid", format!("{}x{}", cols, rows)),
            &(cols, rows),
            |b, &(cols, rows)| {
                b.iter_with_setup(
                    || {
                        let mut grid = make_grid(cols, rows);
                        // Fill scrollback with 10k lines worth of content
                        for _ in 0..10_000 {
                            grid.write_char('X');
                            grid.linefeed();
                        }
                        grid
                    },
                    |mut grid| {
                        grid.scroll_up_in_region();
                        grid
                    },
                );
            },
        );
    }
    group.finish();
}

fn bench_erase_display_full(c: &mut Criterion) {
    let mut group = c.benchmark_group("erase_display_full");
    for (cols, rows) in [(80u16, 24u16), (120, 40), (220, 50)] {
        group.bench_with_input(
            BenchmarkId::new("grid", format!("{}x{}", cols, rows)),
            &(cols, rows),
            |b, &(cols, rows)| {
                b.iter_with_setup(
                    || {
                        let mut grid = make_grid(cols, rows);
                        // Fill grid with content first
                        for _ in 0..(cols as usize * rows as usize) {
                            grid.write_char('A');
                        }
                        grid
                    },
                    |mut grid| {
                        grid.erase_in_display(black_box(2));
                        grid
                    },
                );
            },
        );
    }
    group.finish();
}

fn bench_resize(c: &mut Criterion) {
    let mut group = c.benchmark_group("resize");
    group.bench_function("80x24_to_120x40", |b| {
        b.iter_with_setup(
            || make_grid(80, 24),
            |mut grid| {
                grid.resize(black_box(120), black_box(40));
                grid
            },
        );
    });
    group.bench_function("120x40_to_220x50", |b| {
        b.iter_with_setup(
            || make_grid(120, 40),
            |mut grid| {
                grid.resize(black_box(220), black_box(50));
                grid
            },
        );
    });
    group.bench_function("220x50_to_80x24", |b| {
        b.iter_with_setup(
            || make_grid(220, 50),
            |mut grid| {
                grid.resize(black_box(80), black_box(24));
                grid
            },
        );
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_write_char_line,
    bench_write_char_fill,
    bench_scroll_up,
    bench_erase_display_full,
    bench_resize,
);
criterion_main!(benches);
