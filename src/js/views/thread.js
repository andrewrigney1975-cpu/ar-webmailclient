import { html, icon, render } from '../html.js';

export function renderThread(element, { route }) {
  if (!route.threadId) {
    render(
      element,
      html`<div class="pane__body">
        <dm-empty-state
          icon="mail"
          heading="No conversation selected"
          message="Choose a conversation from the list to read it here."
        ></dm-empty-state>
      </div>`,
    );
    return;
  }

  render(
    element,
    html`
      <header class="app-bar">
        <button class="icon-button app-bar__back" type="button" data-action="back">
          ${icon('back', 'Back')}
        </button>
        <h1 class="app-bar__title">Conversation</h1>
      </header>
      <div class="pane__body"></div>
    `,
  );
}
