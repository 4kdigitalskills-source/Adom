/* ADOM site behaviour: slider, mobile navigation, footer year (logic carried over from the original page). */
(function () {
  'use strict';
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var dotsWrap = document.getElementById('slideDots');
  var nav = document.getElementById('mainNav');
  var menuBtn = document.getElementById('menuToggle');
  var current = 0, timer;

  function resetTimer() {
    clearInterval(timer);
    if (slides.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      timer = setInterval(function () { showSlide(current + 1); }, 5500);
    }
  }
  function showSlide(i) {
    current = (i + slides.length) % slides.length;
    slides.forEach(function (s, n) { s.classList.toggle('active', n === current); });
    Array.prototype.forEach.call(dotsWrap.children, function (d, n) {
      d.classList.toggle('active', n === current);
      d.setAttribute('aria-current', n === current ? 'true' : 'false');
    });
    resetTimer();
  }
  if (slides.length && dotsWrap) {
    slides.forEach(function (_, i) {
      var d = document.createElement('button');
      d.className = 'dot' + (i === 0 ? ' active' : '');
      d.type = 'button';
      d.setAttribute('aria-label', 'Show slide ' + (i + 1));
      d.addEventListener('click', function () { showSlide(i); });
      dotsWrap.appendChild(d);
    });
    document.querySelectorAll('[data-slide]').forEach(function (b) {
      b.addEventListener('click', function () { showSlide(current + Number(b.dataset.slide)); });
    });
    resetTimer();
  }

  function setMenu(open) {
    nav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.textContent = open ? '×' : '☰';
  }
  if (nav && menuBtn) {
    menuBtn.addEventListener('click', function () { setMenu(!nav.classList.contains('open')); });
    nav.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
  }
  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
