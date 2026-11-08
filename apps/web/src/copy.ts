// Copy-to-clipboard buttons for install commands and the agent prompt.
// A button declares `data-copy-target="<element id>"`; the text of that element is copied.

export interface Clipboard {
  writeText(text: string): Promise<void>;
}

const RESET_AFTER_MS = 2000;

/** Wires every copy button under `root`. Returns the number of buttons wired. */
export function setupCopyButtons(root: ParentNode, clipboard: Clipboard | undefined): number {
  const buttons = root.querySelectorAll<HTMLButtonElement>("button[data-copy-target]");
  for (const button of buttons) {
    const label = button.textContent ?? "Copy";
    const status = button.ownerDocument.getElementById(button.dataset.copyStatus ?? "");
    button.addEventListener("click", async () => {
      const target = button.ownerDocument.getElementById(button.dataset.copyTarget ?? "");
      const text = target?.textContent?.trim();
      if (!text || !clipboard) {
        announce(status, "Copy is not available. Select the text and copy it manually.");
        return;
      }
      try {
        await clipboard.writeText(text);
        button.textContent = "Copied";
        announce(status, "Copied to the clipboard.");
      } catch {
        announce(status, "Copy failed. Select the text and copy it manually.");
        return;
      }
      setTimeout(() => {
        button.textContent = label;
      }, RESET_AFTER_MS);
    });
  }
  return buttons.length;
}

function announce(status: HTMLElement | null, message: string): void {
  if (status) status.textContent = message;
}
