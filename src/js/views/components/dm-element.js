import { render } from '../../html.js';

/**
 * Base class for Despatch custom elements. Uses light DOM so the shared
 * stylesheets apply. Subclasses implement `template()` and call `update()`
 * whenever their state changes; observed attributes re-render automatically.
 */
export class DmElement extends HTMLElement {
  connectedCallback() {
    this.update();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.update();
  }

  update() {
    render(this, this.template());
  }

  template() {
    throw new Error(`${this.localName} must implement template()`);
  }
}

export function define(name, elementClass) {
  if (!customElements.get(name)) customElements.define(name, elementClass);
}
