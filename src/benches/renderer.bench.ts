import { bench, describe } from 'vitest'
import { TerminalRenderer, HEADER_SIZE, CELL_SIZE } from '../lib/terminal/renderer'
import { MockCanvas } from './mock-canvas'

const DEFAULT_FG = { r: 0xab, g: 0xb2, b: 0xbf }
const DEFAULT_BG = { r: 0x1e, g: 0x1e, b: 0x1e }

function makeFrame(
  cols: number,
  rows: number,
  fill = 0x41,
  cursorCol = 0,
  cursorRow = 0,
): Uint8Array {
  const size = HEADER_SIZE + cols * rows * CELL_SIZE
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)

  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  view.setUint16(4, cursorCol, true)
  view.setUint16(6, cursorRow, true)
  view.setUint8(8, 1)  // cursorVisible
  view.setUint8(9, 0)  // cursorStyle
  view.setUint8(10, 0) // modeFlags
  view.setUint8(11, 0) // isScrolled

  for (let i = 0; i < rows * cols; i++) {
    const offset = HEADER_SIZE + i * CELL_SIZE
    view.setUint32(offset, fill, true)
    buf[offset + 4] = DEFAULT_FG.r
    buf[offset + 5] = DEFAULT_FG.g
    buf[offset + 6] = DEFAULT_FG.b
    buf[offset + 7] = DEFAULT_BG.r
    buf[offset + 8] = DEFAULT_BG.g
    buf[offset + 9] = DEFAULT_BG.b
    buf[offset + 10] = 0
    buf[offset + 11] = 0
  }
  return buf
}

function makeColorfulFrame(cols: number, rows: number): Uint8Array {
  const size = HEADER_SIZE + cols * rows * CELL_SIZE
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)

  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint8(8, 1)
  view.setUint8(9, 0)
  view.setUint8(10, 0)
  view.setUint8(11, 0)

  for (let i = 0; i < rows * cols; i++) {
    const offset = HEADER_SIZE + i * CELL_SIZE
    view.setUint32(offset, 0x41 + (i % 26), true)
    // Unique color per cell to stress the color-string cache
    buf[offset + 4] = (i * 7) & 0xff
    buf[offset + 5] = (i * 13) & 0xff
    buf[offset + 6] = (i * 17) & 0xff
    buf[offset + 7] = (i * 3) & 0xff
    buf[offset + 8] = (i * 5) & 0xff
    buf[offset + 9] = (i * 11) & 0xff
    buf[offset + 10] = 0
    buf[offset + 11] = 0
  }
  return buf
}

/** Make a frame with only one cell different from the base frame */
function makeSingleCellFrame(base: Uint8Array, col: number, row: number, cols: number): Uint8Array {
  const frame = new Uint8Array(base)
  const view = new DataView(frame.buffer)
  const offset = HEADER_SIZE + (row * cols + col) * CELL_SIZE
  // Change just the codepoint to force a redraw of that cell
  view.setUint32(offset, 0x42, true)
  return frame
}

function makeRenderer(cols: number, rows: number): { renderer: TerminalRenderer; frame: Uint8Array } {
  const canvas = new MockCanvas(cols * 8, rows * 15)
  const renderer = new TerminalRenderer(
    canvas as unknown as HTMLCanvasElement,
    12,
    'monospace',
  )
  // Force cell dimensions since mock measureText returns fixed width
  const frame = makeFrame(cols, rows)
  return { renderer, frame }
}

// --- 80×24 benchmarks ---
describe('renderer 80×24', () => {
  bench('render full 80×24 (all dirty — cold start)', () => {
    // New renderer each time = forceFullRedraw = true
    const canvas = new MockCanvas(640, 360)
    const renderer = new TerminalRenderer(
      canvas as unknown as HTMLCanvasElement,
      12,
      'monospace',
    )
    renderer.render(makeFrame(80, 24))
  })

  bench('render 80×24 (no changes — dirty-region skips all)', () => {
    const { renderer, frame } = makeRenderer(80, 24)
    // Warm up with first render so previousFrame is set
    renderer.render(frame)
    // Bench the no-change path
    bench('inner', () => renderer.render(frame))
  })

  bench('render 80×24 (cursor only — one cell changed)', () => {
    const { renderer, frame } = makeRenderer(80, 24)
    renderer.render(frame)
    const frame2 = makeSingleCellFrame(frame, 1, 0, 80)
    renderer.render(frame2)
  })
})

// Standalone flat benches for cleaner output
{
  const frame80 = makeFrame(80, 24)
  const frame80b = makeFrame(80, 24) // identical copy
  const frame80_1cell = makeSingleCellFrame(frame80, 4, 2, 80)

  bench('render 80×24 incremental (no changes)', () => {
    const canvas = new MockCanvas(640, 360)
    const renderer = new TerminalRenderer(
      canvas as unknown as HTMLCanvasElement,
      12,
      'monospace',
    )
    renderer.render(frame80)   // first frame → previousFrame set
    renderer.render(frame80b)  // same data → all dirty checks skip
  })

  bench('render 80×24 incremental (1 cell changed)', () => {
    const canvas = new MockCanvas(640, 360)
    const renderer = new TerminalRenderer(
      canvas as unknown as HTMLCanvasElement,
      12,
      'monospace',
    )
    renderer.render(frame80)
    renderer.render(frame80_1cell)
  })
}

// --- 120×40 benchmark ---
bench('render full 120×40 (cold start)', () => {
  const canvas = new MockCanvas(960, 600)
  const renderer = new TerminalRenderer(
    canvas as unknown as HTMLCanvasElement,
    12,
    'monospace',
  )
  renderer.render(makeFrame(120, 40))
})

// --- Colorful output (color-string cache stress) ---
bench('render 80×24 colorful (cache stress)', () => {
  const canvas = new MockCanvas(640, 360)
  const renderer = new TerminalRenderer(
    canvas as unknown as HTMLCanvasElement,
    12,
    'monospace',
  )
  renderer.render(makeColorfulFrame(80, 24))
})

// --- Selection extraction ---
{
  const selFrame = makeFrame(80, 24, 0x48 /* 'H' */)

  bench('getSelectedText 80×24', () => {
    const canvas = new MockCanvas(640, 360)
    const renderer = new TerminalRenderer(
      canvas as unknown as HTMLCanvasElement,
      12,
      'monospace',
    )
    renderer.setSelection({ col: 0, row: 0 }, { col: 79, row: 23 })
    renderer.getSelectedText(selFrame)
  })
}
