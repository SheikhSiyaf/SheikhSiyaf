/* Nusuh Books site script. No libraries. Everything here is progressive: the pages read fine without it. */
(function () {
  'use strict';

  var cfg = {};
  try { cfg = JSON.parse(document.getElementById('site-config').textContent); } catch (e) { cfg = {}; }
  var msg = cfg.messages || {};
  var money = function (n) { return (cfg.pricing ? cfg.pricing.currency : 'SAR') + ' ' + Math.round(n).toLocaleString('en-US'); };

  /* ---------- menu and Ask panel: Escape and outside click close them ---------- */
  function closable(sel) {
    var els = document.querySelectorAll(sel);
    Array.prototype.forEach.call(els, function (d) {
      d.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && d.open) { d.open = false; var s = d.querySelector('summary'); if (s) s.focus(); }
      });
    });
    document.addEventListener('click', function (e) {
      Array.prototype.forEach.call(els, function (d) { if (d.open && !d.contains(e.target)) d.open = false; });
    });
  }
  closable('details.menu');
  closable('details.nbask');

  /* ---------- cookie notice: decline by default, choice kept on this device ---------- */
  (function () {
    var box = document.getElementById('cookie-banner');
    if (!box) return;
    var KEY = 'nb-consent', stored = null;
    try { stored = window.localStorage.getItem(KEY); } catch (e) { stored = null; }
    if (!stored) box.hidden = false;
    box.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-consent]') : null;
      if (!b) return;
      try { window.localStorage.setItem(KEY, b.getAttribute('data-consent')); } catch (err) { /* private mode: just hide it */ }
      box.hidden = true;
    });
  })();

  /* ---------- forms ---------- */
  function setMsg(el, text) { if (!el) return; if (text) { el.textContent = text; el.hidden = false; } else { el.hidden = true; } }
  function validate(form) {
    var bad = null, fields = form.querySelectorAll('input,textarea,select');
    Array.prototype.forEach.call(fields, function (f) {
      if (f.type === 'hidden' || f.name === 'website') return;
      var v = (f.value || '').trim(), ok = true;
      if (f.required && !v) ok = false;
      if (ok && f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) ok = false;
      if (ok && f.type === 'file' && f.files && f.files[0] && f.files[0].size > 5 * 1024 * 1024) ok = false;
      if (ok) f.removeAttribute('aria-invalid'); else { f.setAttribute('aria-invalid', 'true'); if (!bad) bad = f; }
    });
    return bad;
  }
  function wireForm(form, onDone) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = form.querySelector('[data-error]'), ok = form.querySelector('[data-ok]');
      var btn = form.querySelector('button[type=submit]');
      setMsg(err, ''); setMsg(ok, '');
      var bad = validate(form);
      if (bad) { setMsg(err, msg.invalid || 'Please check the highlighted fields.'); bad.focus(); return; }
      var label = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.textContent = msg.sending || 'Sending…'; }
      fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (res) {
          if (res.data && res.data.ok) {
            form.reset();
            if (onDone) onDone(); else setMsg(ok, msg.success || 'Thank you.');
            return;
          }
          if (res.status === 429) setMsg(err, msg.tooMany); else if (res.data && res.data.field) { setMsg(err, msg.invalid); var f = form.querySelector('[name="' + res.data.field + '"]'); if (f) { f.setAttribute('aria-invalid', 'true'); f.focus(); } } else setMsg(err, msg.error);
        })
        .catch(function () { setMsg(err, msg.error); })
        .then(function () { if (btn) { btn.disabled = false; btn.innerHTML = label; } });
    });
  }

  /* ---------- order page ---------- */
  var cart = document.querySelector('[data-cart]');
  if (cart && cfg.pricing) {
    var P = cfg.pricing, picked = {}, cleanup = false;
    var step1 = document.getElementById('cart-step1'), step2 = document.getElementById('cart-step2'), done = document.getElementById('cart-done');
    var lines = cart.querySelector('[data-sum-lines]'), actions = cart.querySelector('[data-sum-actions]');
    var names = {}; (cfg.modules || []).forEach(function (m) { names[m.id] = m.name; });
    var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

    var render = function () {
      var ids = Object.keys(picked).filter(function (k) { return picked[k]; });
      var oneTime = P.implementation + (cleanup ? P.cleanup : 0), yearly = P.annualCore + P.perModule * ids.length;
      lines.innerHTML = ids.map(function (id) { return '<div class="ct-line"><span>' + esc(names[id] || id) + '</span><b>' + money(P.perModule) + '</b></div>'; }).join('');
      cart.querySelector('[data-one-time]').textContent = money(oneTime);
      cart.querySelector('[data-yearly]').textContent = money(yearly) + ' / year';
      cart.querySelector('[data-sum-cleanup]').hidden = !cleanup;
      var f = step2; f.elements.modules.value = ids.join(','); f.elements.cleanup.value = cleanup ? '1' : '0';
    };
    Array.prototype.forEach.call(cart.querySelectorAll('[data-module]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-module'); picked[id] = !picked[id];
        b.setAttribute('aria-pressed', picked[id] ? 'true' : 'false'); render();
      });
    });
    var cl = cart.querySelector('[data-cleanup]');
    cl.addEventListener('click', function () { cleanup = !cleanup; cl.setAttribute('aria-pressed', cleanup ? 'true' : 'false'); render(); });
    var show = function (two) {
      step1.hidden = two; step2.hidden = !two; actions.hidden = two;
      document.getElementById('order').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      var first = two ? step2.querySelector('input[name=company]') : step1.querySelector('button'); if (first) first.focus({ preventScroll: true });
    };
    cart.querySelector('[data-pay]').addEventListener('click', function () { show(true); });
    cart.querySelector('[data-back]').addEventListener('click', function () { show(false); });
    wireForm(step2, function () {
      step2.hidden = true; actions.hidden = true; done.hidden = false; done.focus();
      Object.keys(picked).forEach(function (k) { picked[k] = false; }); cleanup = false;
      Array.prototype.forEach.call(cart.querySelectorAll('[aria-pressed=true]'), function (b) { b.setAttribute('aria-pressed', 'false'); });
      render();
    });
    render();
  }

  /* ---------- the other forms ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('form.js-form'), function (f) {
    if (f.id === 'cart-step2') return;
    wireForm(f, null);
  });
})();
