/**
 * E2E test suite runner — imports all specs in order so they run
 * sequentially in a single worker sharing the same Tauri window.
 */
import "./01-app-load.test.js";
import "./02-workspace.test.js";
import "./03-editor.test.js";
import "./04-terminal.test.js";
import "./05-pane-split.test.js";
import "./06-stress.test.js";
import "./07-editor-editing.test.js";
import "./08-file-tree-ops.test.js";
import "./09-multiple-workspaces.test.js";
import "./10-tab-management.test.js";
import "./11-pane-management.test.js";
import "./12-terminal-interaction.test.js";
import "./13-keyboard-shortcuts.test.js";
import "./14-breadcrumbs.test.js";
import "./15-ui-zoom.test.js";
import "./16-advanced-stress.test.js";
import "./17-file-save-verify.test.js";
import "./18-file-tree-extended.test.js";
import "./19-command-palette-exec.test.js";
import "./20-zen-mode.test.js";
import "./21-tab-context-menu.test.js";
import "./22-terminal-search-ui.test.js";
import "./23-memory-leak.test.js";
import "./24-multi-window.test.js";
import "./25-lsp-diagnostics.test.js";
import "./26-lsp-hover.test.js";
import "./27-lsp-completions.test.js";
import "./28-file-tree-clipboard.test.js";
import "./29-copy-on-select.test.js";
import "./30-find-replace.test.js";
import "./31-lsp-didchange.test.js";
import "./32-ssh-connect-error.test.js";
