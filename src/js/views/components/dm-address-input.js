/**
 * <dm-address-input>: recipients as chips, with autocomplete (PLAN.md §4.3).
 *
 *   input.addresses = [{ name, address }]      current value
 *   input.suggest = async (query) => [...]      suggestion source
 *   'change' event whenever the chips change
 *
 * Typing a comma, semicolon or Enter (or leaving the field) turns the text
 * into a chip; pasting a list adds several. Invalid addresses stay as chips,
 * marked, so nothing typed is lost. ARIA combobox pattern for the list.
 */
import { html, icon, render } from '../../html.js';
import { isValidAddress, parseAddressList } from '../../compose/compose-model.js';
import { displayName } from '../../util/format.js';

let counter = 0;

export class DmAddressInput extends HTMLElement {
  #addresses = [];
  #suggestions = [];
  #active = -1;
  #listId = `address-suggestions-${++counter}`;
  #request = 0;
  suggest = async () => [];

  get addresses() {
    return this.#addresses;
  }

  set addresses(value) {
    this.#addresses = [...value];
    if (this.isConnected) this.#renderChips();
  }

  connectedCallback() {
    if (this.querySelector('.address-input')) return;
    render(
      this,
      html`<div class="address-input">
        <span class="address-input__chips"></span>
        <input class="address-input__text" type="email" inputmode="email" autocomplete="off" autocapitalize="off"
          spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-controls="${this.#listId}" aria-label="${this.getAttribute('label') ?? 'Recipients'}" multiple />
        <ul class="address-input__suggestions" id="${this.#listId}" role="listbox" hidden></ul>
      </div>`,
    );
    this.input = this.querySelector('input');
    this.list = this.querySelector('ul');
    this.#renderChips();

    this.input.addEventListener('input', () => this.#onInput());
    this.input.addEventListener('keydown', (event) => this.#onKeyDown(event));
    this.input.addEventListener('blur', () => {
      this.#commitText();
      this.#closeSuggestions();
    });
    this.input.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text');
      if (text && /[,;\n]/.test(text)) {
        event.preventDefault();
        this.#add(parseAddressList(text));
      }
    });
    // pointerdown (not click) so choosing doesn't blur the input first.
    this.list.addEventListener('pointerdown', (event) => {
      const option = event.target.closest('[role=option]');
      if (!option) return;
      event.preventDefault();
      this.#choose(Number(option.dataset.index));
    });
    this.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove]');
      if (remove) {
        this.#addresses.splice(Number(remove.dataset.remove), 1);
        this.#changed();
        this.input.focus();
      } else if (event.target === this || event.target.closest('.address-input') && !event.target.closest('button, li')) {
        this.input.focus();
      }
    });
  }

  /** Commits any typed text; call before reading `addresses` on send. */
  flush() {
    this.#commitText();
  }

  #changed() {
    this.#renderChips();
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  #renderChips() {
    const chips = this.querySelector('.address-input__chips');
    if (!chips) return;
    render(
      chips,
      html`${this.#addresses.map(
        (person, index) => html`<span class="chip${isValidAddress(person.address) ? '' : ' chip--invalid'}" title="${person.address}">
          <span class="chip__label">${displayName(person)}</span>
          <button class="chip__remove" type="button" data-remove="${index}">${icon('close', `Remove ${person.address}`)}</button>
        </span>`,
      )}`,
    );
  }

  #add(people) {
    const known = new Set(this.#addresses.map((p) => p.address));
    for (const person of people) {
      if (!known.has(person.address)) {
        this.#addresses.push(person);
        known.add(person.address);
      }
    }
    this.#changed();
  }

  #commitText() {
    const text = this.input?.value.trim();
    if (!text) return;
    this.input.value = '';
    this.#add(parseAddressList(text));
  }

  async #onInput() {
    const value = this.input.value;
    // Android keyboards don't send reliable key events for "," so check the text.
    if (/[,;]/.test(value)) {
      this.#commitText();
      this.#closeSuggestions();
      return;
    }
    const request = ++this.#request;
    const query = value.trim();
    const results = query.length >= 1 ? await this.suggest(query) : [];
    if (request !== this.#request) return;
    const taken = new Set(this.#addresses.map((p) => p.address));
    this.#suggestions = results.filter((p) => !taken.has(p.address));
    this.#active = this.#suggestions.length ? 0 : -1;
    this.#renderSuggestions();
  }

  #renderSuggestions() {
    const open = this.#suggestions.length > 0;
    this.list.hidden = !open;
    this.input.setAttribute('aria-expanded', String(open));
    render(
      this.list,
      html`${this.#suggestions.map(
        (person, index) => html`<li id="${this.#listId}-${index}" role="option" data-index="${index}"
          aria-selected="${String(index === this.#active)}" class="address-input__option">
          <span class="address-input__name">${person.name || person.address}</span>
          ${person.name ? html`<span class="address-input__address">${person.address}</span>` : ''}
        </li>`,
      )}`,
    );
    if (this.#active >= 0) this.input.setAttribute('aria-activedescendant', `${this.#listId}-${this.#active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  #closeSuggestions() {
    this.#request += 1;
    this.#suggestions = [];
    this.#active = -1;
    if (this.list) this.#renderSuggestions();
  }

  #choose(index) {
    const person = this.#suggestions[index];
    if (!person) return;
    this.input.value = '';
    this.#add([person]);
    this.#closeSuggestions();
  }

  #onKeyDown(event) {
    const open = this.#suggestions.length > 0;
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      this.#active = (this.#active + 1) % this.#suggestions.length;
      this.#renderSuggestions();
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault();
      this.#active = (this.#active - 1 + this.#suggestions.length) % this.#suggestions.length;
      this.#renderSuggestions();
    } else if ((event.key === 'Enter' || event.key === 'Tab') && open && this.#active >= 0) {
      event.preventDefault();
      this.#choose(this.#active);
    } else if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      if (this.input.value.trim()) {
        event.preventDefault();
        this.#commitText();
        this.#closeSuggestions();
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      this.#closeSuggestions();
    } else if (event.key === 'Backspace' && !this.input.value && this.#addresses.length) {
      this.#addresses.pop();
      this.#changed();
    }
  }
}


if (!customElements.get('dm-address-input')) customElements.define('dm-address-input', DmAddressInput);
