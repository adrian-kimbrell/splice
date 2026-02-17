export interface Settings {
  editor: {
    font_family: string;
    font_size: number;
    tab_size: number;
    word_wrap: boolean;
    line_numbers: boolean;
    minimap: boolean;
  };
  appearance: {
    theme: string;
    ui_scale: number;
    show_status_bar: boolean;
  };
  terminal: {
    default_shell: string;
    font_size: number;
    cursor_style: string;
    cursor_blink: boolean;
    scrollback_lines: number;
  };
}

export const settings = $state<Settings>({
  editor: {
    font_family: "Menlo",
    font_size: 13,
    tab_size: 4,
    word_wrap: false,
    line_numbers: true,
    minimap: false,
  },
  appearance: {
    theme: "One Dark",
    ui_scale: 100,
    show_status_bar: true,
  },
  terminal: {
    default_shell: "/bin/zsh",
    font_size: 12,
    cursor_style: "Block",
    cursor_blink: true,
    scrollback_lines: 10000,
  },
});
