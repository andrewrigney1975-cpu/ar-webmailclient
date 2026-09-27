import { html, icon, render } from '../html.js';

export function renderSettings(element) {
  render(
    element,
    html`
      <header class="app-bar">
        <button class="icon-button" type="button" data-action="back">${icon('back', 'Back')}</button>
        <h1 class="app-bar__title">Settings</h1>
      </header>
      <div class="pane__body">
        <dm-empty-state
          icon="settings"
          heading="Accounts"
          message="Account setup arrives in milestone 2."
        ></dm-empty-state>
      </div>
    `,
  );
}
