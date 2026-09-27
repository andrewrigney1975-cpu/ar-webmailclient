/**
 * Event editor for a date suggestion (PLAN.md §4.7): title, date, time or
 * all day, reminder and notes. Resolves with { event, action } where action
 * is 'open', 'save' or 'share', or null if cancelled.
 */
import { html, icon, render } from '../../html.js';
import { REMINDERS } from '../../calendar/ics.js';
import { openDialog } from './overlays.js';

const pad = (n) => String(n).padStart(2, '0');
const dateValue = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeValue = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function localTime(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, h, min).getTime();
}

/** Reads the form into an event (exported for tests). */
export function readEventForm(form, base) {
  const allDay = form.allDay.checked;
  const date = form.date.value;
  const start = allDay ? localTime(date, '00:00') : localTime(date, form.startTime.value);
  let end = allDay ? start + 86_400_000 : localTime(date, form.endTime.value);
  if (end <= start) end = allDay ? start + 86_400_000 : start + 3_600_000;
  const reminder = form.reminder.value;
  return {
    ...base,
    title: form.title.value.trim() || 'Event',
    allDay,
    start,
    end,
    reminderMinutes: reminder === '' ? null : Number(reminder),
    description: form.notes.value,
  };
}

export function editEvent(router, event) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog event-editor';
  render(
    dialog,
    html`
      <form method="dialog" class="event-editor__form">
        <h2 class="dialog__title">${icon('event')} Add to calendar</h2>
        <label class="field"><span>Title</span><input name="title" value="${event.title}" required /></label>
        <label class="checkbox"><input type="checkbox" name="allDay" ${event.allDay ? 'checked' : ''} /><span>All day</span></label>
        <label class="field"><span>Date</span><input type="date" name="date" value="${dateValue(event.start)}" required /></label>
        <div class="field-row field-row--times" ${event.allDay ? 'hidden' : ''}>
          <label class="field"><span>Starts</span><input type="time" name="startTime" value="${timeValue(event.start)}" /></label>
          <label class="field"><span>Ends</span><input type="time" name="endTime" value="${timeValue(event.end)}" /></label>
        </div>
        <label class="field">
          <span>Reminder</span>
          <select name="reminder">
            ${REMINDERS.map(
              (r) => html`<option value="${r.minutes ?? ''}" ${r.minutes === event.reminderMinutes ? 'selected' : ''}>${r.label}</option>`,
            )}
          </select>
        </label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="3">${event.description ?? ''}</textarea></label>
        <div class="dialog__actions event-editor__actions">
          <button class="text-button" type="button" value="cancel">Cancel</button>
          <button class="text-button" type="button" value="share">${icon('share')} Share</button>
          <button class="text-button" type="button" value="save">${icon('download')} Save</button>
          <button class="button" type="button" value="open">Open in Calendar</button>
        </div>
      </form>
    `,
  );
  const form = dialog.querySelector('form');
  form.allDay.addEventListener('change', () => {
    dialog.querySelector('.field-row--times').hidden = form.allDay.checked;
  });

  return openDialog(router, dialog, (finish) => {
    dialog.addEventListener('click', (e) => {
      const button = e.target.closest('button[value]');
      if (!button) return;
      if (button.value === 'cancel') finish(null);
      else if (form.reportValidity?.() !== false) finish({ event: readEventForm(form, event), action: button.value });
    });
  });
}
