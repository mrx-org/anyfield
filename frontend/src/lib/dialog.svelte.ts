// One dialog per page for questions to the user: confirm something or enter a text
// (instead of the browser's confirm() and prompt(), which an MCP App's sandboxed
// iframe may not show). Shown by components/Dialogs.svelte, which the website and
// the MCP App shell mount once, like the toaster.

export interface AskOptions {
  title: string;
  message?: string;
  /** Show a text field with this value; the answer is its text. */
  input?: string;
  placeholder?: string;
  /** Label of the confirming button (default: OK). */
  confirm?: string;
  /** The confirming button in the error colour (e.g. delete). */
  danger?: boolean;
}

interface Open extends AskOptions {
  resolve: (answer: string | null) => void;
}

class Dialogs {
  current = $state<Open | null>(null);
}
export const dialogs = new Dialogs();

/** Ask: resolves with the text (or "" without a text field), null if cancelled. */
export function ask(options: AskOptions): Promise<string | null> {
  dialogs.current?.resolve(null);
  return new Promise((resolve) => {
    dialogs.current = {
      ...options,
      resolve: (answer) => {
        dialogs.current = null;
        resolve(answer);
      },
    };
  });
}

/** Yes or no. */
export const askConfirm = async (options: Omit<AskOptions, "input" | "placeholder">) => (await ask(options)) !== null;

/** A text (trimmed; null if cancelled or empty). */
export async function askText(options: AskOptions & { input: string }): Promise<string | null> {
  const answer = (await ask(options))?.trim();
  return answer ? answer : null;
}
