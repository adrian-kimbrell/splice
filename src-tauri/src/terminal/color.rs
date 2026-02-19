#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

pub const DEFAULT_FG: Rgb = Rgb {
    r: 0xab,
    g: 0xb2,
    b: 0xbf,
};
pub const DEFAULT_BG: Rgb = Rgb {
    r: 0x1e,
    g: 0x1e,
    b: 0x1e,
};

/// One Dark inspired 16-color ANSI palette
pub const ANSI_COLORS: [Rgb; 16] = [
    // Normal colors (0-7)
    Rgb { r: 0x28, g: 0x2c, b: 0x34 }, // 0 black
    Rgb { r: 0xe0, g: 0x6c, b: 0x75 }, // 1 red
    Rgb { r: 0x98, g: 0xc3, b: 0x79 }, // 2 green
    Rgb { r: 0xe5, g: 0xc0, b: 0x7b }, // 3 yellow
    Rgb { r: 0x61, g: 0xaf, b: 0xef }, // 4 blue
    Rgb { r: 0xc6, g: 0x78, b: 0xdd }, // 5 magenta
    Rgb { r: 0x56, g: 0xb6, b: 0xc2 }, // 6 cyan
    Rgb { r: 0xab, g: 0xb2, b: 0xbf }, // 7 white
    // Bright colors (8-15)
    Rgb { r: 0x5c, g: 0x63, b: 0x70 }, // 8  bright black
    Rgb { r: 0xe0, g: 0x6c, b: 0x75 }, // 9  bright red
    Rgb { r: 0x98, g: 0xc3, b: 0x79 }, // 10 bright green
    Rgb { r: 0xe5, g: 0xc0, b: 0x7b }, // 11 bright yellow
    Rgb { r: 0x61, g: 0xaf, b: 0xef }, // 12 bright blue
    Rgb { r: 0xc6, g: 0x78, b: 0xdd }, // 13 bright magenta
    Rgb { r: 0x56, g: 0xb6, b: 0xc2 }, // 14 bright cyan
    Rgb { r: 0xff, g: 0xff, b: 0xff }, // 15 bright white
];

/// Convert a 256-color index to RGB
pub fn ansi_256_color(index: u8) -> Rgb {
    match index {
        0..=15 => ANSI_COLORS[index as usize],
        16..=231 => {
            // 6x6x6 color cube
            let idx = index - 16;
            let b = idx % 6;
            let g = (idx / 6) % 6;
            let r = idx / 36;
            Rgb {
                r: if r > 0 { 55 + 40 * r } else { 0 },
                g: if g > 0 { 55 + 40 * g } else { 0 },
                b: if b > 0 { 55 + 40 * b } else { 0 },
            }
        }
        232..=255 => {
            // Grayscale ramp
            let v = 8 + 10 * (index - 232);
            Rgb { r: v, g: v, b: v }
        }
    }
}
