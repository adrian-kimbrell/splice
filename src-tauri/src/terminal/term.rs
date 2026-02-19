use crate::terminal::color::{ansi_256_color, Rgb, ANSI_COLORS, DEFAULT_BG, DEFAULT_FG};
use crate::terminal::grid::{flags, Grid};
use smallvec::SmallVec;

pub struct Emulator {
    parser: vte::Parser,
    pub grid: Grid,
    pub pending_title: Option<String>,
    pub pending_reply: Vec<u8>,
    pub pending_bell: bool,
}

impl Emulator {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vte::Parser::new(),
            grid: Grid::new(cols, rows),
            pending_title: None,
            pending_reply: Vec::new(),
            pending_bell: false,
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

impl<'a> vte::Perform for GridPerformer<'a> {
    fn print(&mut self, c: char) {
        self.grid.write_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => *self.pending_bell = true,
            0x08 => self.grid.backspace(),                // BS
            0x09 => self.grid.tab(),                      // HT
            0x0A | 0x0B | 0x0C => self.grid.linefeed(),  // LF, VT, FF
            0x0D => self.grid.carriage_return(),          // CR
            0x0E => {}                                    // SO (shift out) — no-op
            0x0F => {}                                    // SI (shift in) — no-op
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
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
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
