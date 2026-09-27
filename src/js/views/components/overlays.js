/**
 * Transient UI: snackbar messages (with optional Undo), a bottom sheet for
 * choosing from a list, and a confirmation dialog. Sheets and dialogs
 * register with the router so the back gesture closes them first.
 */
import { html, icon, render } from '../../html.js';

export function createSnackbar(element) {
  let timer = null;

  function hide() {
    clearTimeout(timer);
    element.classList.remove('snackbar--visible');
  }

  return {
    /** @param {{ action?: string, onAction?: () => void, durationMs?: number }} options */
    show(message, { action, onAction, durationMs = 5000 } = {}) {
      clearTimeout(timer);
      render(
        element,
        html`<p class="snackbar__text">${message}</p>
          ${action ? html`<button class="snackbar__action" type="button">${action}</button>` : ''}`,
      );
      element.querySelector('.snackbar__action')?.addEventListener('click', () => {
        hide();
        onAction?.();
      });
      element.classList.add('snackbar--visible');
      timer = setTimeout(hide, durationMs);
    },
    hide,
  };
}

/**
 * Shows a bottom sheet with a list of choices. Resolves with the chosen value,
 * or null if dismissed.
 * @param {{ title: string, items: { value: any, label: string, icon?: string, depth?: number }[] }} options
 */
export function chooseFromSheet(router, { title, items, empty = 'Nothing to choose from.' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    render(
      dialog,
      html`
        <h2 class="sheet__title">${title}</h2>
        ${items.length === 0 ? html`<p class="sheet__empty">${empty}</p>` : ''}
        <ul class="sheet__list" role="list">
          ${items.map(
            (item, index) => html`<li>
              <button class="sheet__item" type="button" data-index="${index}" style="--depth: ${item.depth ?? 0}">
                ${item.icon ? icon(item.icon) : ''}<span>${item.label}</span>
              </button>
            </li>`,
          )}
        </ul>
      `,
    );
    document.body.append(dialog);

    let result = null;
    const unregister = router.pushOverlay(() => dialog.close());
    dialog.addEventListener('close', () => {
      unregister();
      dialog.remove();
      resolve(result);
    });
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('.sheet__item');
      if (button) {
        result = items[Number(button.dataset.index)].value;
        dialog.close();
      } else if (event.target === dialog) {
        dialog.close(); // tap on the backdrop
      }
    });
    dialog.showModal();
  });
}

/** Resolves true if the user confirms. */
export function confirmDialog(router, { title, message, confirm, danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    render(
      dialog,
      html`
        <h2 class="dialog__title">${title}</h2>
        <p class="dialog__message">${message}</p>
        <div class="dialog__actions">
          <button class="text-button" type="button" value="cancel">Cancel</button>
          <button class="text-button${danger ? ' text-button--danger' : ''}" type="button" value="confirm">${confirm}</button>
        </div>
      `,
    );
    document.body.append(dialog);

    let confirmed = false;
    const unregister = router.pushOverlay(() => dialog.close());
    dialog.addEventListener('close', () => {
      unregister();
      dialog.remove();
      resolve(confirmed);
    });
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      confirmed = button.value === 'confirm';
      dialog.close();
    });
    dialog.showModal();
  });
}
