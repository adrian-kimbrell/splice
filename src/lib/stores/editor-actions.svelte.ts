export const editorActions = $state({
  pending: null as string | null,
  gotoLineNumber: null as number | null,
});

export function dispatchEditorAction(action: string, lineNumber?: number) {
  editorActions.gotoLineNumber = lineNumber ?? null;
  editorActions.pending = action;
}
