'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const V = require('../server/validate');
const { goodEnquiry } = require('./helpers');

test('Ghana phone normalisation', () => {
  assert.equal(V.normalizeGhanaPhone('024 666 3591'), '+233246663591');
  assert.equal(V.normalizeGhanaPhone('+233 27 324 2468'), '+233273242468');
  assert.equal(V.normalizeGhanaPhone('233246663591'), '+233246663591');
  for (const bad of ['12345', '0146663591', '+44 7700 900123', 'abc', '', '024666359', '+2332466635912']) assert.equal(V.normalizeGhanaPhone(bad), null, bad);
});
test('valid enquiry passes and is normalised', () => {
  const r = V.validateEnquiry(goodEnquiry()); assert.equal(r.ok, true); assert.equal(r.value.phone, '+233241234567');
});
test('consent is required, service is whitelisted, required fields enforced', () => {
  const r = V.validateEnquiry(goodEnquiry({ consent: false, service: 'Free money', name: '', location: '' }));
  assert.equal(r.ok, false); for (const k of ['consent', 'service', 'name', 'location']) assert.ok(r.errors[k], k);
});
test('every service on the public form is accepted (incl. Mercedes/BMW/Porsche car AC work)', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
  const opts = [...html.matchAll(/<option>([^<]+)<\/option>/g)].map((m) => m[1]);
  assert.deepEqual(opts.sort(), [...V.SERVICES].sort());
  for (const make of ['Mercedes-Benz', 'BMW', 'Porsche']) assert.equal(V.validateEnquiry(goodEnquiry({ vehicle: make })).ok, true);
});
test('control characters stripped and lengths capped', () => {
  const r = V.validateEnquiry(goodEnquiry({ name: 'A\u0000B\u0007 C', message: 'x'.repeat(5000) }));
  assert.equal(r.value.name, 'A B C'); assert.equal(r.value.message.length, 1500);
});
test('status transitions', () => {
  assert.ok(V.canTransition('new', 'contacted')); assert.ok(V.canTransition('booked', 'completed'));
  assert.ok(!V.canTransition('new', 'completed')); assert.ok(!V.canTransition('completed', 'new')); assert.ok(V.canTransition('cancelled', 'new'));
});
test('commission maths uses integer pesewas and rounds half up', () => {
  assert.equal(V.parseGhs('1234.56'), 123456); assert.equal(V.parseGhs('450'), 45000); assert.ok(Number.isNaN(V.parseGhs('12.345'))); assert.ok(Number.isNaN(V.parseGhs('-5')));
  assert.equal(V.commissionPesewas(123456, V.rateToBp(7.5)), 9259);
  assert.equal(V.commissionPesewas(10000, V.rateToBp(10)), 1000);
  assert.equal(V.commissionPesewas(1, V.rateToBp(50)), 1); // 0.5 pesewa rounds up
  assert.equal(V.commissionPesewas(0, V.rateToBp(10)), 0);
});
