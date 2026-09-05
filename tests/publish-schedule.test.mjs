import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const registeredWidgets = [];
const context = {
  CMS: {
    registerWidget(name, control) {
      registeredWidgets.push({ name, control });
    },
  },
  Date,
  console,
  createClass(definition) {
    return definition;
  },
  window: { h() {} },
};

vm.runInNewContext(readFileSync(new URL('../publish-schedule.js', import.meta.url), 'utf8'), context);

const helpers = context.window.JCCPublishSchedule;
const control = registeredWidgets.find((widget) => widget.name === 'publish-schedule').control;

test('converts between Taipei wall time and canonical ISO timestamps', () => {
  assert.equal(helpers.fromTaipeiInput('2026-09-05T17:00'), '2026-09-05T09:00:00.000Z');
  assert.equal(helpers.toTaipeiInput('2026-09-05T09:00:00.000Z'), '2026-09-05T17:00');
});

test('creates an initial schedule at least ten minutes in the future', () => {
  const now = new Date();
  const scheduled = new Date(helpers.fromTaipeiInput(helpers.earliestScheduleValue(now)));
  assert.ok(scheduled.getTime() >= now.getTime() + 10 * 60 * 1000);
});

test('validates scheduled lead time while allowing immediate publication', () => {
  const tooSoon = new Date(Date.now() + 9 * 60 * 1000).toISOString();
  const later = new Date(Date.now() + 11 * 60 * 1000).toISOString();

  assert.equal(control.isValid.call({ props: { value: tooSoon }, state: { mode: 'immediate' } }), true);
  assert.notEqual(control.isValid.call({ props: { value: tooSoon }, state: { mode: 'scheduled' } }), true);
  assert.equal(control.isValid.call({ props: { value: later }, state: { mode: 'scheduled' } }), true);
});
