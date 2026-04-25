/**
 * Saved terminal prompts store.
 *
 * Prompts are persisted to localStorage under the key "splice_saved_prompts".
 * Each entry has a unique id, a display name, and the prompt text.
 * Mutations (add/delete) write through to localStorage immediately.
 */

export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
}

const STORAGE_KEY = "splice_saved_prompts";

function load(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persist(prompts: SavedPrompt[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  } catch {
    // ignore quota errors
  }
}

export const savedPrompts = $state<SavedPrompt[]>(load());

export function addSavedPrompt(name: string, text: string): void {
  const entry: SavedPrompt = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: name.trim(),
    text,
  };
  savedPrompts.push(entry);
  persist(savedPrompts);
}

export function deleteSavedPrompt(id: string): void {
  const idx = savedPrompts.findIndex(p => p.id === id);
  if (idx !== -1) {
    savedPrompts.splice(idx, 1);
    persist(savedPrompts);
  }
}
