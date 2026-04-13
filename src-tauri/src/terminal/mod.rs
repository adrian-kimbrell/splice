//! Terminal emulator subsystem.
//!
//! Data flow:
//!   PTY output bytes
//!     → `term::Emulator::advance` (VTE parser → `GridPerformer`)
//!     → `grid::Grid` mutated in place
//!     → `emitter` thread detects version bump, serializes to binary frame
//!     → Tauri event `terminal:grid:<id>` (base64) → `ipc/events.ts` → `TerminalRenderer`
//!
//! Module breakdown:
//! - `grid`:    Cell / Row / ScreenBuffer / Grid data structures; primary + alt screens
//! - `term`:    VTE `Perform` impl (`GridPerformer`) that drives grid mutations
//! - `pty`:     Spawns the shell via `portable-pty`; owns reader thread + emitter thread
//! - `emitter`: Binary protocol serialization and rate-limited Tauri event loop
//! - `color`:   RGB type + ANSI 256-color palette

pub mod color;
pub mod emitter;
pub mod grid;
pub mod pty;
pub mod term;

#[cfg(test)]
mod tests;
