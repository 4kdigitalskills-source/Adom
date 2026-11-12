(function () {
  'use strict';
  var form = document.getElementById('loginForm'), msg = document.getElementById('loginMsg');
  function loadApp() {
    var s = document.createElement('script'); s.src = '/admin/app.js'; // only served to signed-in admins
    document.body.appendChild(s);
    document.getElementById('login').hidden = true; document.getElementById('app').hidden = false;
  }
  fetch('/api/admin/me').then(function (r) { if (r.ok) loadApp(); });
  form.addEventListener('submit', function (e) {
    e.preventDefault(); msg.textContent = '';
    fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value, code: document.getElementById('code').value }) })
      .then(function (r) {
        if (r.ok) return loadApp();
        msg.textContent = r.status === 429 ? 'Too many attempts. Wait and try again.' : r.status === 503 ? 'Admin sign-in is not configured on this server.' : 'Email, password or code is incorrect.';
      }).catch(function () { msg.textContent = 'Could not reach the server.'; });
  });
})();
