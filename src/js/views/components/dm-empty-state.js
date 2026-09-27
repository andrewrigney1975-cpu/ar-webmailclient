import { html, icon } from '../../html.js';
import { DmElement, define } from './dm-element.js';

/**
 * <dm-empty-state icon="mail" heading="…" message="…" action-label="…" action-href="…">
 */
export class DmEmptyState extends DmElement {
  static observedAttributes = ['icon', 'heading', 'message', 'action-label', 'action-href'];

  template() {
    const actionLabel = this.getAttribute('action-label');
    return html`
      <div class="empty-state">
        ${icon(this.getAttribute('icon') ?? 'mail')}
        <p class="empty-state__title">${this.getAttribute('heading')}</p>
        <p>${this.getAttribute('message')}</p>
        ${actionLabel && html`<a class="button" href="${this.getAttribute('action-href')}">${actionLabel}</a>`}
      </div>
    `;
  }
}

define('dm-empty-state', DmEmptyState);
