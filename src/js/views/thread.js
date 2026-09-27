import { html, icon, render } from '../html.js';
import { displayName, formatAddressList, formatFullDate, formatSize } from '../util/format.js';

/**
 * Reading pane. For now this shows one message with its plain-text body;
 * sandboxed HTML rendering arrives in milestone 3 and conversations in milestone 4.
 */
export function renderThread(element, { route, message, account, body, bodyError }) {
  if (!route.threadId || !message) {
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

  let content;
  if (bodyError) {
    content = html`<div class="banner banner--error" role="status">${icon('error')}<p>${bodyError}</p></div>`;
  } else if (body === undefined) {
    content = html`<p class="message__loading">Loading…</p>`;
  } else {
    content = html`<div class="message__body">${body || '(This message has no text.)'}</div>`;
  }

  render(
    element,
    html`
      <header class="app-bar">
        <button class="icon-button app-bar__back" type="button" data-action="back">${icon('back', 'Back')}</button>
        <h1 class="app-bar__title visually-hidden">Message</h1>
      </header>
      <div class="pane__body">
        <article class="message" style="--row-accent: ${account?.accentColor ?? 'var(--accent)'}">
          <h2 class="message__subject">${message.subject || '(no subject)'}</h2>
          <dl class="message__meta">
            <dt>From</dt>
            <dd>${message.from ? formatAddressList([message.from]) : displayName(null)}</dd>
            ${message.to.length ? html`<dt>To</dt><dd>${formatAddressList(message.to)}</dd>` : ''}
            ${message.cc.length ? html`<dt>Cc</dt><dd>${formatAddressList(message.cc)}</dd>` : ''}
            <dt>Date</dt>
            <dd>${formatFullDate(message.dateSent ?? message.dateReceived)}</dd>
            ${message.hasAttachments ? html`<dt>${icon('attach', 'Attachments')}</dt><dd>Has attachments · ${formatSize(message.size)}</dd>` : ''}
          </dl>
          ${content}
        </article>
      </div>
    `,
  );
}
