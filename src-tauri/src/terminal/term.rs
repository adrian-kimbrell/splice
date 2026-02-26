use base64::Engine;
use crate::terminal::color::{ansi_256_color, Rgb, ANSI_COLORS, DEFAULT_BG, DEFAULT_FG};
use crate::terminal::grid::{flags, Grid};
use smallvec::SmallVec;

pub struct Emulator {
    parser: vte::Parser,
    pub grid: Grid,
    pub pending_title: Option<String>,
    pub pending_reply: Vec<u8>,
    pub pending_bell: bool,
    pub pending_clipboard: Option<String>,
}

impl Emulator {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        Self {
            parser: vte::Parser::new(),
            grid: Grid::new(cols, rows, scrollback),
            pending_title: None,
            pending_reply: Vec::new(),
            pending_bell: false,
            pending_clipboard: None,
        }
    }

    pub fn advance(&mut self, bytes: &[u8]) {
        let parser = &mut self.parser;
        let grid = &mut self.grid;
        let mut performer = GridPerformer {
            grid,
            pending_title: &mut self.pending_title,
            pending_reply: &mut self.pending_reply,
            pending_bell: &mut self.pending_bell,
            pending_clipboard: &mut self.pending_clipboard,
        };
        parser.advance(&mut performer, bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.grid.resize(cols, rows);
    }
}

struct GridPerformer<'a> {
    grid: &'a mut Grid,
    pending_title: &'a mut Option<String>,
    pending_reply: &'a mut Vec<u8>,
    pending_bell: &'a mut bool,
    pending_clipboard: &'a mut Option<String>,
}

impl<'a> GridPerformer<'a> {
    fn get_param(params_vec: &[&[u16]], idx: usize, default: u16) -> u16 {
        params_vec
            .get(idx)
            .and_then(|p| p.first())
            .copied()
            .map(|v| if v == 0 { default } else { v })
            .unwrap_or(default)
    }

    fn handle_sgr(&mut self, params: &vte::Params) {
        // Flatten all params into a small inline vec for indexed iteration
        let flat: SmallVec<[u16; 16]> = params.iter().flat_map(|p| p.iter().copied()).collect();

        if flat.is_empty() {
            self.grid.active_mut().pen = Default::default();
            return;
        }

        let pen = &mut self.grid.active_mut().pen;
        let mut i = 0;
        while i < flat.len() {
            match flat[i] {
                0 => *pen = Default::default(),
                1 => pen.flags |= flags::BOLD,
                2 => pen.flags |= flags::DIM,
                3 => pen.flags |= flags::ITALIC,
                4 => pen.flags |= flags::UNDERLINE,
                5 => pen.flags |= flags::BLINK,
                7 => pen.flags |= flags::INVERSE,
                8 => pen.flags |= flags::HIDDEN,
                9 => pen.flags |= flags::STRIKETHROUGH,
                22 => pen.flags &= !(flags::BOLD | flags::DIM),
                23 => pen.flags &= !flags::ITALIC,
                24 => pen.flags &= !flags::UNDERLINE,
                25 => pen.flags &= !flags::BLINK,
                27 => pen.flags &= !flags::INVERSE,
                28 => pen.flags &= !flags::HIDDEN,
                29 => pen.flags &= !flags::STRIKETHROUGH,
                // Standard foreground colors
                30..=37 => pen.fg = ANSI_COLORS[(flat[i] - 30) as usize],
                38 => {
                    // Extended foreground
                    if i + 1 < flat.len() {
                        match flat[i + 1] {
                            5 if i + 2 < flat.len() => {
                                pen.fg = ansi_256_color(flat[i + 2] as u8);
                                i += 2;
                            }
                            2 if i + 4 < flat.len() => {
                                pen.fg = Rgb {
                                    r: flat[i + 2] as u8,
                                    g: flat[i + 3] as u8,
                                    b: flat[i + 4] as u8,
                                };
                                i += 4;
                            }
                            _ => {}
                        }
                    }
                }
                39 => pen.fg = DEFAULT_FG,
                // Standard background colors
                40..=47 => pen.bg = ANSI_COLORS[(flat[i] - 40) as usize],
                48 => {
                    // Extended background
                    if i + 1 < flat.len() {
                        match flat[i + 1] {
                            5 if i + 2 < flat.len() => {
                                pen.bg = ansi_256_color(flat[i + 2] as u8);
                                i += 2;
                            }
                            2 if i + 4 < flat.len() => {
                                pen.bg = Rgb {
                                    r: flat[i + 2] as u8,
                                    g: flat[i + 3] as u8,
                                    b: flat[i + 4] as u8,
                                };
                                i += 4;
                            }
                            _ => {}
                        }
                    }
                }
                49 => pen.bg = DEFAULT_BG,
                // Bright foreground colors
                90..=97 => pen.fg = ANSI_COLORS[(flat[i] - 90 + 8) as usize],
                // Bright background colors
                100..=107 => pen.bg = ANSI_COLORS[(flat[i] - 100 + 8) as usize],
                _ => {}
            }
            i += 1;
        }
    }
}

/// Map DEC special graphics characters (0x60–0x7E) to Unicode box-drawing/symbols.
fn dec_special_map(c: char) -> char {
    match c {
        'j' => '┘',
        'k' => '┐',
        'l' => '┌',
        'm' => '└',
        'n' => '┼',
        'q' => '─',
        't' => '├',
        'u' => '┤',
        'v' => '┴',
        'w' => '┬',
        'x' => '│',
        '`' => '◆',
        'a' => '▒',
        'f' => '°',
        'g' => '±',
        'o' => '⎺',
        'p' => '⎻',
        'r' => '⎼',
        's' => '⎽',
        'y' => '≤',
        'z' => '≥',
        '{' => 'π',
        '}' => '£',
        '~' => '·',
        _ => c,
    }
}

impl<'a> vte::Perform for GridPerformer<'a> {
    fn print(&mut self, c: char) {
        // Apply active charset mapping (DEC special graphics, etc.)
        let buf = self.grid.active();
        let charset = if buf.active_charset == 0 { buf.charset_g0 } else { buf.charset_g1 };
        let mapped = if charset == 1 { dec_special_map(c) } else { c };
        self.grid.write_char(mapped);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => *self.pending_bell = true,
            0x08 => self.grid.backspace(),                // BS
            0x09 => self.grid.tab(),                      // HT
            0x0A | 0x0B | 0x0C => self.grid.linefeed(),  // LF, VT, FF
            0x0D => self.grid.carriage_return(),          // CR
            0x0E => self.grid.active_mut().active_charset = 1, // SO: shift to G1
            0x0F => self.grid.active_mut().active_charset = 0, // SI: shift to G0
            _ => {}
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        let params_vec: Vec<&[u16]> = params.iter().collect();
        let has_question = intermediates.contains(&b'?');
        let has_space = intermediates.contains(&b' ');

        if has_question {
            // Handle all ?-mode params (may be multiple, e.g. ESC[?1049;1h)
            for param_slice in &params_vec {
                let mode = param_slice.first().copied().unwrap_or(0);
                match action {
                    'h' => match mode {
                        1 => self.grid.app_cursor_keys = true,
                        7 => self.grid.auto_wrap = true,
                        12 => {} // cursor blink — no-op
                        25 => self.grid.cursor_visible = true,
                        47 | 1047 => self.grid.enter_alt_screen_simple(),
                        1000 => self.grid.mouse_mode = 1,
                        1002 => self.grid.mouse_mode = 2,
                        1003 => self.grid.mouse_mode = 3,
                        1004 => self.grid.focus_events = true,
                        1006 => self.grid.mouse_sgr = true,
                        1048 => self.grid.save_cursor(),
                        1049 => self.grid.enter_alt_screen(),
                        2004 => self.grid.bracketed_paste = true,
                        2026 => {} // synchronized update — no-op
                        _ => {}
                    },
                    'l' => match mode {
                        1 => self.grid.app_cursor_keys = false,
                        7 => self.grid.auto_wrap = false,
                        12 => {} // cursor blink — no-op
                        25 => self.grid.cursor_visible = false,
                        47 | 1047 => self.grid.leave_alt_screen_simple(),
                        1000 => { if self.grid.mouse_mode == 1 { self.grid.mouse_mode = 0; } }
                        1002 => { if self.grid.mouse_mode == 2 { self.grid.mouse_mode = 0; } }
                        1003 => { if self.grid.mouse_mode == 3 { self.grid.mouse_mode = 0; } }
                        1004 => self.grid.focus_events = false,
                        1006 => self.grid.mouse_sgr = false,
                        1048 => self.grid.restore_cursor(),
                        1049 => self.grid.leave_alt_screen(),
                        2004 => self.grid.bracketed_paste = false,
                        2026 => {} // synchronized update — no-op
                        _ => {}
                    },
                    _ => {}
                }
            }
            return;
        }

        // CSI Ps SP q — DECSCUSR (cursor style)
        if action == 'q' && has_space {
            let style = Self::get_param(&params_vec, 0, 0);
            self.grid.cursor_style = style as u8;
            return;
        }

        match action {
            'A' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.cursor_up(n);
            }
            'B' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.cursor_down(n);
            }
            'C' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.cursor_forward(n);
            }
            'D' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.cursor_back(n);
            }
            'E' => {
                // CNL — Cursor Next Line: move down N lines, then CR
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.cursor_down(n);
                self.grid.carriage_return();
            }
            'F' => {
                // CPL — Cursor Previous Line: move up N lines, then CR
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.cursor_up(n);
                self.grid.carriage_return();
            }
            'G' => {
                let col = Self::get_param(&params_vec, 0, 1).max(1) - 1;
                self.grid.set_cursor_pos(self.grid.cursor_row(), col);
            }
            'H' | 'f' => {
                let row = Self::get_param(&params_vec, 0, 1).max(1) - 1;
                let col = Self::get_param(&params_vec, 1, 1).max(1) - 1;
                self.grid.set_cursor_pos(row, col);
            }
            'J' => {
                let mode = Self::get_param(&params_vec, 0, 0);
                self.grid.erase_in_display(mode);
            }
            'K' => {
                let mode = Self::get_param(&params_vec, 0, 0);
                self.grid.erase_in_line(mode);
            }
            'L' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.insert_lines(n);
            }
            'M' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.delete_lines(n);
            }
            'S' => {
                let n = Self::get_param(&params_vec, 0, 1);
                for _ in 0..n {
                    self.grid.scroll_up_in_region();
                }
            }
            'T' => {
                let n = Self::get_param(&params_vec, 0, 1);
                for _ in 0..n {
                    self.grid.scroll_down_in_region();
                }
            }
            'X' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.erase_chars(n);
            }
            '@' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.insert_blank_chars(n);
            }
            'P' => {
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.delete_chars(n);
            }
            'd' => {
                // VPA — vertical position absolute (1-based)
                let row = Self::get_param(&params_vec, 0, 1).max(1) - 1;
                self.grid.set_cursor_pos(row, self.grid.cursor_col());
            }
            'r' => {
                // DECSTBM — set scroll region
                let top = Self::get_param(&params_vec, 0, 1).max(1) - 1;
                let bottom = Self::get_param(&params_vec, 1, self.grid.rows).max(1) - 1;
                self.grid.set_scroll_region(top, bottom);
            }
            'c' => {
                if intermediates.contains(&b'>') {
                    // Secondary Device Attributes (CSI > c)
                    self.pending_reply
                        .extend_from_slice(b"\x1b[>0;0;0c");
                } else {
                    // Primary Device Attributes — respond with VT100 with advanced video
                    self.pending_reply
                        .extend_from_slice(b"\x1b[?1;2c");
                }
            }
            'n' => {
                // DSR — Device Status Report
                let mode = Self::get_param(&params_vec, 0, 0);
                match mode {
                    5 => {
                        // Terminal OK
                        self.pending_reply.extend_from_slice(b"\x1b[0n");
                    }
                    6 => {
                        // Cursor position (1-based)
                        let row = self.grid.cursor_row() + 1;
                        let col = self.grid.cursor_col() + 1;
                        let reply = format!("\x1b[{};{}R", row, col);
                        self.pending_reply.extend_from_slice(reply.as_bytes());
                    }
                    _ => {}
                }
            }
            'Z' => {
                // CBT — Cursor Backward Tab
                let n = Self::get_param(&params_vec, 0, 1);
                self.grid.backtab(n);
            }
            'b' => {
                // REP — Repeat last character
                let n = Self::get_param(&params_vec, 0, 1);
                let ch = self.grid.last_char;
                for _ in 0..n {
                    self.grid.write_char(ch);
                }
            }
            'g' => {
                // TBC — Tab Clear
                let mode = Self::get_param(&params_vec, 0, 0);
                self.grid.clear_tab_stop(mode);
            }
            's' => self.grid.save_cursor(),
            'u' => self.grid.restore_cursor(),
            'm' => self.handle_sgr(params),
            _ => {}
        }
    }

    fn hook(
        &mut self,
        _params: &vte::Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
    }

    fn put(&mut self, _byte: u8) {}

    fn unhook(&mut self) {}

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.is_empty() {
            return;
        }
        match params[0] {
            b"0" | b"2" => {
                // Set window title
                if params.len() > 1 {
                    if let Ok(title) = std::str::from_utf8(params[1]) {
                        *self.pending_title = Some(title.to_string());
                    }
                }
            }
            b"52" => {
                // OSC 52: clipboard write
                // Format: ESC ] 52 ; Pc ; Pd BEL
                // params[1] = selection (e.g. "c" for clipboard), params[2] = base64 data
                if params.len() >= 3 {
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(params[2]) {
                        if let Ok(text) = String::from_utf8(decoded) {
                            *self.pending_clipboard = Some(text);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (intermediates.first(), byte) {
            // DEC charset designation
            (Some(b'('), b'B') => self.grid.active_mut().charset_g0 = 0, // G0 = ASCII
            (Some(b'('), b'0') => self.grid.active_mut().charset_g0 = 1, // G0 = DEC special
            (Some(b')'), b'B') => self.grid.active_mut().charset_g1 = 0, // G1 = ASCII
            (Some(b')'), b'0') => self.grid.active_mut().charset_g1 = 1, // G1 = DEC special
            _ => {}
        }
        match (byte, intermediates) {
            (b'7', _) => self.grid.save_cursor(),           // DECSC
            (b'8', &[b'#']) => self.grid.alignment_test(),  // DECALN (ESC # 8)
            (b'8', _) => self.grid.restore_cursor(),        // DECRC
            (b'D', _) => self.grid.index(),                 // IND — Index
            (b'E', _) => {                                  // NEL — Next Line
                self.grid.carriage_return();
                self.grid.linefeed();
            }
            (b'H', _) => self.grid.set_tab_stop(),          // HTS — Horizontal Tab Set
            (b'M', _) => self.grid.reverse_index(),          // RI
            (b'=', _) => self.grid.app_keypad = true,        // DECKPAM
            (b'>', _) => self.grid.app_keypad = false,       // DECKPNM
            (b'c', _) => self.grid.full_reset(),             // RIS
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::color::{Rgb, ANSI_COLORS};
    use crate::terminal::grid::flags;

    fn make_emu(cols: u16, rows: u16) -> Emulator {
        Emulator::new(cols, rows, 1000)
    }

    // --- Plain text ---

    #[test]
    fn plain_text_writes_chars_to_grid() {
        let mut emu = make_emu(20, 5);
        emu.advance(b"Hello");
        assert_eq!(emu.grid.primary.lines[0].cells[0].ch, 'H');
        assert_eq!(emu.grid.primary.lines[0].cells[1].ch, 'e');
        assert_eq!(emu.grid.primary.lines[0].cells[2].ch, 'l');
        assert_eq!(emu.grid.primary.lines[0].cells[3].ch, 'l');
        assert_eq!(emu.grid.primary.lines[0].cells[4].ch, 'o');
    }

    #[test]
    fn auto_wrap_wraps_to_next_row() {
        let mut emu = make_emu(5, 3);
        emu.advance(b"ABCDEFG"); // 7 chars on a 5-wide terminal
        assert_eq!(emu.grid.primary.lines[0].cells[4].ch, 'E');
        assert_eq!(emu.grid.primary.lines[1].cells[0].ch, 'F');
        assert_eq!(emu.grid.primary.lines[1].cells[1].ch, 'G');
    }

    // --- Cursor movement ---

    #[test]
    fn cup_sets_cursor_position() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[2;5H"); // CUP: row=2, col=5 (1-based)
        assert_eq!(emu.grid.cursor_row(), 1); // 0-based
        assert_eq!(emu.grid.cursor_col(), 4); // 0-based
    }

    #[test]
    fn cuu_moves_cursor_up_one_row() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[5;1H"); // move to row 5 (0-based: 4)
        emu.advance(b"\x1b[A");    // CUU: up 1
        assert_eq!(emu.grid.cursor_row(), 3);
    }

    #[test]
    fn cud_moves_cursor_down_two_rows() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[1;1H"); // move to row 1, col 1 (0-based: row 0)
        emu.advance(b"\x1b[2B");   // CUD: down 2
        assert_eq!(emu.grid.cursor_row(), 2);
    }

    // --- SGR attributes ---

    #[test]
    fn sgr_bold_sets_bold_flag() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[1m");
        assert_ne!(emu.grid.primary.pen.flags & flags::BOLD, 0);
    }

    #[test]
    fn sgr_reset_clears_bold_flag() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[1m\x1b[0m");
        assert_eq!(emu.grid.primary.pen.flags & flags::BOLD, 0);
    }

    #[test]
    fn sgr_truecolor_foreground() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[38;2;255;0;0m");
        assert_eq!(emu.grid.primary.pen.fg, Rgb { r: 255, g: 0, b: 0 });
    }

    #[test]
    fn sgr_ansi_color_foreground() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[31m"); // ANSI red = color index 1
        assert_eq!(emu.grid.primary.pen.fg, ANSI_COLORS[1]);
    }

    // --- Screen operations ---

    #[test]
    fn ed2_clears_screen_and_sets_cleared_flag() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"Hello");
        emu.advance(b"\x1b[2J");
        assert_eq!(emu.grid.primary.lines[0].cells[0].ch, ' ');
        assert!(emu.grid.primary.cleared);
    }

    #[test]
    fn alt_screen_switch_enter_and_leave() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"Main");
        emu.advance(b"\x1b[?1049h"); // enter alt screen
        assert!(emu.grid.active_is_alt);
        emu.advance(b"\x1b[?1049l"); // leave alt screen
        assert!(!emu.grid.active_is_alt);
        // Primary content should be restored
        assert_eq!(emu.grid.primary.lines[0].cells[0].ch, 'M');
    }

    #[test]
    fn lf_at_scroll_bottom_triggers_scroll_up() {
        let mut emu = make_emu(10, 3); // scroll_bottom = 2
        emu.advance(b"A");            // write 'A' at (0,0)
        emu.advance(b"\x1b[3;1H");   // cursor to row 3 (0-based: 2) = scroll_bottom
        emu.advance(b"\n");           // LF at bottom → scroll_up_in_region

        // Original row 0 ('A') should now be in scrollback
        assert_eq!(emu.grid.primary.scrollback.len(), 1);
        assert_eq!(emu.grid.primary.scrollback[0].cells[0].ch, 'A');
    }

    // --- Title OSC ---

    #[test]
    fn osc_0_sets_pending_title() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b]0;My Title\x07");
        assert_eq!(emu.pending_title, Some("My Title".to_string()));
    }

    // --- DEC special graphics charset ---

    #[test]
    fn dec_special_graphics_maps_box_drawing() {
        let mut emu = make_emu(20, 5);
        // ESC ( 0 → designate G0 as DEC special graphics
        // SI already selects G0 (active_charset=0)
        emu.advance(b"\x1b(0");
        emu.advance(b"jklm"); // ┘┐┌└
        assert_eq!(emu.grid.primary.lines[0].cells[0].ch, '┘');
        assert_eq!(emu.grid.primary.lines[0].cells[1].ch, '┐');
        assert_eq!(emu.grid.primary.lines[0].cells[2].ch, '┌');
        assert_eq!(emu.grid.primary.lines[0].cells[3].ch, '└');
    }

    #[test]
    fn so_si_switches_charsets() {
        let mut emu = make_emu(20, 5);
        emu.advance(b"\x1b(0"); // G0 = DEC special
        emu.advance(b"\x1b)B"); // G1 = ASCII
        emu.advance(b"\x0e"); // SO: switch to G1 (ASCII)
        emu.advance(b"j");    // should be literal 'j', not '┘'
        assert_eq!(emu.grid.primary.lines[0].cells[0].ch, 'j');
        emu.advance(b"\x0f"); // SI: switch back to G0 (DEC special)
        emu.advance(b"j");    // should be '┘'
        assert_eq!(emu.grid.primary.lines[0].cells[1].ch, '┘');
    }

    // --- Mouse protocol ---

    #[test]
    fn mouse_mode_1000_set_and_clear() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[?1000h");
        assert_eq!(emu.grid.mouse_mode, 1);
        emu.advance(b"\x1b[?1000l");
        assert_eq!(emu.grid.mouse_mode, 0);
    }

    #[test]
    fn mouse_sgr_set_and_clear() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[?1006h");
        assert!(emu.grid.mouse_sgr);
        emu.advance(b"\x1b[?1006l");
        assert!(!emu.grid.mouse_sgr);
    }

    // --- Focus events ---

    #[test]
    fn focus_events_set_and_clear() {
        let mut emu = make_emu(80, 24);
        emu.advance(b"\x1b[?1004h");
        assert!(emu.grid.focus_events);
        emu.advance(b"\x1b[?1004l");
        assert!(!emu.grid.focus_events);
    }

    // --- OSC 52 clipboard ---

    #[test]
    fn osc_52_decodes_base64_clipboard() {
        let mut emu = make_emu(80, 24);
        // base64("hello") = "aGVsbG8="
        emu.advance(b"\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(emu.pending_clipboard, Some("hello".to_string()));
    }
}
