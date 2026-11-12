/* Enquiry form: client-side checks for convenience only; the server re-validates everything. */
(function () {
  'use strict';
  var form = document.getElementById('enquiryForm');
  if (!form) return;
  var status = document.getElementById('formStatus');
  var wa = document.getElementById('waFallback');
  var btn = form.querySelector('button[type="submit"]');
  var started = Date.now();

  function say(text, kind) { status.textContent = text; status.className = 'form-status ' + (kind || ''); }

  function waLink(data) {
    var lines = ['Hello ADOM, I would like to enquire about: ' + data.service,
      'Name: ' + data.name, 'Area: ' + data.location];
    if (data.vehicle) lines.push('Vehicle: ' + data.vehicle);
    if (data.message) lines.push('Issue: ' + data.message);
    return 'https://wa.me/233246663591?text=' + encodeURIComponent(lines.join('\n'));
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    wa.hidden = true;
    if (!form.reportValidity()) return;
    var fd = new FormData(form);
    var data = {
      name: fd.get('name'), phone: fd.get('phone'), service: fd.get('service'),
      location: fd.get('location'), vehicle: fd.get('vehicle'), message: fd.get('message'),
      consent: document.getElementById('consent').checked,
      website: fd.get('website'),               // honeypot, must stay empty
      elapsedMs: Date.now() - started           // very fast submissions are treated as bots
    };
    btn.disabled = true; say('Sending your enquiry…');
    fetch('/api/enquiries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.ok && res.body.reference) {
          // Only claim success when the server confirms the enquiry was stored.
          say('Enquiry received and saved. Your reference is ' + res.body.reference + '. Please quote it if you contact the workshop.', 'ok');
          form.reset(); started = Date.now();
        } else if (res.status === 422 && res.body.errors) {
          say(Object.keys(res.body.errors).map(function (k) { return res.body.errors[k]; }).join(' '), 'error');
        } else if (res.status === 429) {
          say('Too many enquiries from this connection. Please wait a few minutes or call the workshop.', 'error');
        } else {
          say('We could not save your enquiry online right now, so it has NOT been sent. Please call +233 24 666 3591 or use WhatsApp below.', 'error');
          wa.href = waLink(data); wa.hidden = false;
        }
      })
      .catch(function () {
        say('We could not reach the server, so your enquiry has NOT been sent. Please call +233 24 666 3591 or use WhatsApp below.', 'error');
        wa.href = waLink(data); wa.hidden = false;
      })
      .then(function () { btn.disabled = false; });
  });
})();
