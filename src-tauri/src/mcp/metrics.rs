//! Per-tool-call metrics collected when an MCP request opts in via `verbose: true`.
//!
//! Every tool wraps its work in a `Metrics::start()` → `metrics.finish(result)` pair.
//! When verbose is requested, the metrics block is appended to the JSON response so
//! a dev-mode caller can inspect timing, byte counts, and any subsystem breakdowns
//! without changing the protocol.

use serde::{Serialize, Deserialize};
use std::time::Instant;

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct Metrics {
    /// Total time spent inside the tool handler.
    pub duration_ms: u64,
    /// Bytes read from disk or memory by this call (best-effort).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_read: Option<u64>,
    /// Bytes written to disk or terminals by this call (best-effort).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_written: Option<u64>,
    /// Files / entries touched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items_touched: Option<u64>,
    /// Arbitrary microsecond timings keyed by subsystem (validate_path, fs_read, etc.).
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty", default)]
    pub subsystem_us: std::collections::BTreeMap<String, u64>,
}

pub struct MetricsTimer {
    started: Instant,
    metrics: Metrics,
}

impl MetricsTimer {
    pub fn start() -> Self {
        Self { started: Instant::now(), metrics: Metrics::default() }
    }

    pub fn bytes_read(&mut self, n: u64) { self.metrics.bytes_read = Some(self.metrics.bytes_read.unwrap_or(0) + n); }
    // Used once we add write_file / write_to_terminal tools.
    #[allow(dead_code)]
    pub fn bytes_written(&mut self, n: u64) { self.metrics.bytes_written = Some(self.metrics.bytes_written.unwrap_or(0) + n); }
    pub fn items(&mut self, n: u64) { self.metrics.items_touched = Some(self.metrics.items_touched.unwrap_or(0) + n); }

    /// Time a subsystem call. The closure runs and its duration is recorded under `key`.
    pub fn time<T>(&mut self, key: &str, f: impl FnOnce() -> T) -> T {
        let t = Instant::now();
        let out = f();
        self.metrics.subsystem_us.insert(key.to_string(), t.elapsed().as_micros() as u64);
        out
    }

    /// Stamp duration_ms and consume into a Metrics block, or return None if not verbose.
    pub fn finish(mut self, verbose: bool) -> Option<Metrics> {
        if !verbose { return None; }
        self.metrics.duration_ms = self.started.elapsed().as_millis() as u64;
        Some(self.metrics)
    }
}
