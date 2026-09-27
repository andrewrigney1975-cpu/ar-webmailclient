/**
 * Tagged template for building HTML strings. Interpolated values are escaped
 * unless wrapped with `raw()`; arrays are joined. Email content never goes
 * through here: it is rendered in a sandboxed iframe (PLAN.md §4.8).
 */

const RAW = Symbol('raw');

export function raw(markup) {
  return { [RAW]: String(markup) };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (typeof value === 'object' && RAW in value) return value[RAW];
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += renderValue(value) + strings[i + 1];
  });
  return raw(out);
}

/** Replaces an element's content with an `html` result. */
export function render(element, template) {
  element.innerHTML = template[RAW];
}

export function icon(name, label) {
  return label
    ? html`<svg class="icon" role="img" aria-label="${label}"><use href="#i-${name}"></use></svg>`
    : html`<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
