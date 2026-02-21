import { bench, describe } from 'vitest'
import { HEADER_SIZE, CELL_SIZE } from '../lib/terminal/renderer'

// Binary protocol constants (must match Rust emitter.rs)
const DEFAULT_FG = { r: 0xab, g: 0xb2, b: 0xbf }
const DEFAULT_BG = { r: 0x1e, g: 0x1e, b: 0x1e }

/**
 * Build a synthetic binary frame matching the protocol:
 * Header (12 bytes): cols(u16le), rows(u16le), cursorCol(u16le),
 *                    cursorRow(u16le), cursorVisible(u8), cursorStyle(u8),
 *                    modeFlags(u8), isScrolled(u8)
 * Cells (12 bytes each): codepoint(u32le), fgR, fgG, fgB, bgR, bgG, bgB,
 *                        flags(u8), reserved(u8)
 */
function makeFrame(cols: number, rows: number, fill = 0x41 /* 'A' */): Uint8Array {
  const size = HEADER_SIZE + cols * rows * CELL_SIZE
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)

  // Header
  view.setUint16(0, cols, true)   // cols
  view.setUint16(2, rows, true)   // rows
  view.setUint16(4, 0, true)      // cursorCol
  view.setUint16(6, 0, true)      // cursorRow
  view.setUint8(8, 1)             // cursorVisible
  view.setUint8(9, 0)             // cursorStyle
  view.setUint8(10, 0)            // modeFlags
  view.setUint8(11, 0)            // isScrolled

  // Cells
  for (let i = 0; i < rows * cols; i++) {
    const offset = HEADER_SIZE + i * CELL_SIZE
    view.setUint32(offset, fill, true)          // codepoint
    buf[offset + 4] = DEFAULT_FG.r
    buf[offset + 5] = DEFAULT_FG.g
    buf[offset + 6] = DEFAULT_FG.b
    buf[offset + 7] = DEFAULT_BG.r
    buf[offset + 8] = DEFAULT_BG.g
    buf[offset + 9] = DEFAULT_BG.b
    buf[offset + 10] = 0  // flags
    buf[offset + 11] = 0  // reserved
  }
  return buf
}

/**
 * Parse the 12-byte header from a binary frame.
 * Returns { cols, rows, cursorCol, cursorRow, cursorVisible, isScrolled }.
 */
function parseHeader(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    cols: view.getUint16(0, true),
    rows: view.getUint16(2, true),
    cursorCol: view.getUint16(4, true),
    cursorRow: view.getUint16(6, true),
    cursorVisible: view.getUint8(8) !== 0,
    cursorStyle: view.getUint8(9),
    modeFlags: view.getUint8(10),
    isScrolled: view.getUint8(11) !== 0,
  }
}

/**
 * Parse every cell in a frame, returning the total number of non-space
 * codepoints (prevents dead-code elimination by the JIT).
 */
function parseAllCells(data: Uint8Array, cols: number, rows: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let nonSpace = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const offset = HEADER_SIZE + (row * cols + col) * CELL_SIZE
      const cp = view.getUint32(offset, true)
      if (cp > 32) nonSpace++
    }
  }
  return nonSpace
}

/**
 * Dirty-region check: compare two frames byte-by-byte per cell,
 * return the number of changed cells.
 */
function dirtyRegionCheck(prev: Uint8Array, next: Uint8Array, cols: number, rows: number): number {
  let changed = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const offset = HEADER_SIZE + (row * cols + col) * CELL_SIZE
      let same = true
      for (let b = 0; b < CELL_SIZE; b++) {
        if (prev[offset + b] !== next[offset + b]) {
          same = false
          break
        }
      }
      if (!same) changed++
    }
  }
  return changed
}

// Pre-build frames outside bench loops so construction cost isn't measured.
const frame80x24 = makeFrame(80, 24)
const frame120x40 = makeFrame(120, 40)
const frame220x50 = makeFrame(220, 50)
// Identical clone for dirty-region no-change case
const frame80x24b = makeFrame(80, 24)
// One-cell-different frame
const frame80x24_mod = new Uint8Array(frame80x24)
frame80x24_mod[HEADER_SIZE] = 0x42 // change first cell codepoint byte

describe('binary protocol: header parsing', () => {
  bench('parse header (80×24)', () => {
    parseHeader(frame80x24)
  })

  bench('parse header (120×40)', () => {
    parseHeader(frame120x40)
  })

  bench('parse header (220×50)', () => {
    parseHeader(frame220x50)
  })
})

describe('binary protocol: full frame parsing', () => {
  bench('parse frame 80×24 (1920 cells)', () => {
    parseAllCells(frame80x24, 80, 24)
  })

  bench('parse frame 120×40 (4800 cells)', () => {
    parseAllCells(frame120x40, 120, 40)
  })

  bench('parse frame 220×50 (11000 cells)', () => {
    parseAllCells(frame220x50, 220, 50)
  })
})

describe('binary protocol: dirty-region check', () => {
  bench('dirty check 80×24 (no changes)', () => {
    dirtyRegionCheck(frame80x24, frame80x24b, 80, 24)
  })

  bench('dirty check 80×24 (1 cell changed)', () => {
    dirtyRegionCheck(frame80x24, frame80x24_mod, 80, 24)
  })

  bench('dirty check 120×40 (no changes)', () => {
    const clone = makeFrame(120, 40)
    dirtyRegionCheck(frame120x40, clone, 120, 40)
  })
})
