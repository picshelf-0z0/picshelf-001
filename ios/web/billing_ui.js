/* Google Play is the entitlement and checkout-price authority. No local purchase simulation. */
(() => {
  'use strict';
  const plans = {
    yearly: { id: 'yearly', productId: 'picshelf_pro_yearly', price: 299, durationMonths: 12, suffix: 'Yearly' },
    half_yearly: { id: 'half_yearly', productId: 'picshelf_pro_half_yearly', price: 170, durationMonths: 6, suffix: 'HalfYearly' },
    three_monthly: { id: 'three_monthly', productId: 'picshelf_pro_three_monthly', price: 99, durationMonths: 3, suffix: 'ThreeMonthly' }
  };
  let snapshot = { configured: false, isPro: false, status: 'unavailable', prices: {} };
  let attachedState = null;
  let statusKey = '';
  let restoring = false;
  const tr = (key, params) => window.t ? window.t(key, params) : key;
  const text = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const locale = () => (attachedState?.language || localStorage.getItem('photo_org_language') || 'en') + '-IN';
  const number = value => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(value);
  function money(amount, currency = 'INR', monthly = false) {
    return new Intl.NumberFormat(locale(), { style: 'currency', currency,
      minimumFractionDigits: monthly ? 2 : (Number.isInteger(amount) ? 0 : 2), maximumFractionDigits: 2 }).format(amount);
  }
  function isPro() {
    const now = Date.now();
    return snapshot.configured === true && snapshot.isPro === true &&
      (!Number.isFinite(snapshot.offlineUntil) || now <= snapshot.offlineUntil) &&
      (!Number.isFinite(snapshot.checkedAt) || now >= snapshot.checkedAt);
  }
  function readNative() {
    try {
      const raw = window.AndroidApp?.getGooglePlayBillingState?.();
      const next = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (next && typeof next === 'object') return next;
    } catch (error) { console.warn('Google Play status unavailable'); }
    return { configured: false, isPro: false, status: 'unavailable', prices: {} };
  }
  function refresh(render = false) {
    const wasPro = isPro();
    const previousPlan = snapshot.plan;
    snapshot = readNative();
    if (isPro() && plans[snapshot.plan] && (!wasPro || previousPlan !== snapshot.plan)) window.selectedSubscriptionPlan = snapshot.plan;
    if (attachedState) attachedState.proPlan = isPro() ? (snapshot.plan || null) : null;
    if (restoring && !['connecting', 'checking'].includes(snapshot.status)) {
      restoring = false;
      statusKey = isPro() ? 'billing_restored' : statusMessage();
    } else if (statusKey === 'billing_loading' && isPro()) {
      // A foreground ownership query can grant access without delivering
      // the checkout callback that normally replaces this loading message.
      statusKey = 'billing_active';
    }
    if (render) {
      updateUI();
      if (wasPro !== isPro() && window.libraryStartupReady === true && typeof window.renderAll === 'function') window.renderAll();
    }
    return isPro();
  }
  function statusMessage() {
    if (!snapshot.configured) return 'billing_not_configured';
    if (snapshot.status === 'pending') return 'billing_pending';
    if (['unverified', 'verification_required', 'verification_failed', 'invalid_receipt'].includes(snapshot.status)) return 'billing_unverified';
    if (['offline', 'expired_cache', 'clock_error'].includes(snapshot.status)) return 'billing_offline';
    if (['connecting', 'checking'].includes(snapshot.status)) return 'billing_loading';
    if (['none', 'inactive', 'not_owned', 'not_entitled'].includes(snapshot.status)) return 'billing_none';
    return 'billing_unavailable';
  }
  function setStatus(key) {
    statusKey = key;
    // Positive result text must not outlive the native grant or its deadline.
    const displayedKey = ['billing_active', 'billing_restored'].includes(key) && !isPro() ? statusMessage() : key;
    document.querySelectorAll('[data-billing-status]').forEach(el => { el.textContent = displayedKey ? tr(displayedKey) : ''; el.hidden = !displayedKey; });
  }
  function attachState(state) {
    attachedState = state;
    Object.defineProperty(state, 'isPro', { enumerable: true, configurable: false, get: isPro,
      // Legacy backups and assignments must never grant an entitlement.
      set() {} });
    refresh(false);
  }
  function priceFor(plan) {
    const native = snapshot.prices?.[plan.productId];
    const amount = native && Number.isFinite(native.priceAmountMicros) ? native.priceAmountMicros / 1e6 : plan.price;
    const currency = native?.currencyCode || 'INR';
    return { formatted: typeof native === 'string' ? native : native?.formattedPrice || money(amount, currency),
      monthly: money(amount / plan.durationMonths, currency, true) };
  }
  function updateUI() {
    const selected = plans[window.selectedSubscriptionPlan] || plans.yearly;
    for (const plan of Object.values(plans)) {
      const price = priceFor(plan), months = number(plan.durationMonths);
      const badge = tr(plan.id === 'yearly' ? 'billing_best_value' : plan.id === 'half_yearly' ? 'billing_popular' : 'billing_flexible');
      for (const prefix of ['settings', 'modal', 'vipImport']) {
        const card = document.getElementById(prefix + 'PlanCard' + plan.suffix);
        if (card) {
          card.classList.toggle('active', selected.id === plan.id);
          card.setAttribute('aria-pressed', String(selected.id === plan.id));
          const name = card.querySelector('.settings-plan-name'); if (name) name.textContent = tr('billing_plan_months', { months });
          const unit = card.querySelector('.settings-plan-unit'); if (unit) unit.textContent = '/ ' + tr('billing_period', { months });
        }
        text(prefix + 'Price' + plan.suffix + 'Display', price.formatted);
        text(prefix + 'Subtext' + plan.suffix, tr('billing_per_month', { price: price.monthly }));
        text(prefix + 'PlanBadge' + plan.suffix, badge);
      }
      const card = document.getElementById('rzpPlanCard' + plan.suffix);
      if (card) {
        card.classList.toggle('active', selected.id === plan.id);
        card.setAttribute('aria-pressed', String(selected.id === plan.id));
        card.querySelector('.rzp-plan-name').textContent = tr('billing_plan_months', { months });
        card.querySelector('.rzp-plan-tenure').textContent = '/ ' + tr('billing_period', { months });
      }
      text('rzpModalPrice' + plan.suffix, price.formatted);
      text('rzpModalSubtext' + plan.suffix, tr('billing_per_month', { price: price.monthly }));
      text('rzpModalBadge' + plan.suffix, badge);
    }
    const price = priceFor(selected).formatted, months = number(selected.durationMonths);
    for (const id of ['proActivePricingTag', 'modalProActivePricingTag', 'vipImportProActivePricingTag']) text(id, price + ' / ' + tr('billing_period', { months }));
    for (const id of ['startRazorpayBtnText', 'modalStartRazorpayBtnText', 'vipImportStartRazorpayBtnText']) text(id, isPro() ? tr('billing_active') : tr('billing_upgrade', { price }));
    text('rzpSelectedAmountBadge', price);
    text('rzpSelectedPlanTitle', tr('billing_selected', { plan: tr('billing_plan_months', { months }) }));
    text('confirmPaymentBtnText', tr('billing_continue', { price }));
    document.querySelectorAll('[data-billing-renewal]').forEach(el => { el.textContent = tr('billing_renewal', { months, price }); });
    const album = document.getElementById('vipImportModalAlbumName');
    if (album?.parentElement) {
      // Preserve the album-name node used by the existing import entry point.
      const name = album.textContent;
      const label = album.parentElement.querySelector('[data-billing-import-label]');
      if (label) label.textContent = tr('billing_direct_import', { album: name });
    }
    setStatus(statusKey);
  }
  function select(planId) {
    if (!Object.prototype.hasOwnProperty.call(plans, planId)) return;
    cancelPendingCheckout();
    window.selectedSubscriptionPlan = planId;
    setStatus(''); updateUI();
  }
  function close() {
    cancelPendingCheckout();
    if (typeof window.closeVipSaveLimitModal === 'function') window.closeVipSaveLimitModal();
    else { const modal = document.getElementById('vipSaveLimitModal'); if (modal) modal.style.display = 'none'; }
    for (const id of ['razorpayModal', 'vipDirectImportModal']) {
      const legacy = document.getElementById(id); if (legacy) legacy.style.display = 'none';
    }
  }
  function open() {
    refresh(false);
    for (const id of ['razorpayModal', 'vipDirectImportModal']) {
      const legacy = document.getElementById(id); if (legacy) legacy.style.display = 'none';
    }
    const toast = document.getElementById('toastMessage');
    if (toast) { toast.classList.remove('show'); clearTimeout(toast._toastTimer); }
    const modal = document.getElementById('vipSaveLimitModal');
    if (modal) {
      // Translate this shared dialog at its entry point, without rerendering
      // the underlying screen or relying on a legacy translation hook.
      for (const [attribute, target] of [['data-i18n', null], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label']]) {
        modal.querySelectorAll('[' + attribute + ']').forEach(node => {
          const value = tr(node.getAttribute(attribute));
          if (target) node.setAttribute(target, value); else node.textContent = value;
        });
      }
    }
    updateUI();
    if (modal) modal.style.display = 'flex';
  }
  document.addEventListener('keydown', event => {
    const modal = document.getElementById('vipSaveLimitModal');
    if (event.key !== 'Escape' || !modal || modal.style.display === 'none') return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  }, true);
  function purchase() {
    refresh(false);
    if (isPro()) { setStatus('billing_active'); return; }
    if (!snapshot.configured) { setStatus('billing_not_configured'); return; }
    const selected = plans[window.selectedSubscriptionPlan];
    if (!selected) { setStatus('billing_failed'); return; }
    const requestId = String(++checkoutRequestId);
    setStatus('billing_loading');
    try {
      if (window.AndroidApp?.launchGooglePlayBilling?.(selected.id, requestId)) return;
    } catch (_) {}
    setStatus('billing_unavailable');
  }
  function restore() {
    cancelPendingCheckout();
    restoring = true; setStatus('billing_restoring');
    try {
      if (typeof window.AndroidApp?.restoreGooglePlayPurchases === 'function') { window.AndroidApp.restoreGooglePlayPurchases(); return; }
    } catch (_) {}
    restoring = false; setStatus('billing_unavailable');
  }
  function manage() {
    cancelPendingCheckout();
    try {
      if (window.AndroidApp?.openGooglePlaySubscriptions?.()) return;
    } catch (_) {}
    setStatus('billing_unavailable');
  }
  window.subscriptionPlans = plans;
  window.selectedSubscriptionPlan = 'yearly';
  let checkoutRequestId = 0;
  function cancelPendingCheckout() {
    checkoutRequestId++;
    if (statusKey === 'billing_loading' && !restoring) setStatus('billing_canceled');
    try { window.AndroidApp?.cancelGooglePlayBilling?.(); } catch (_) {}
  }
  window.PicShelfBilling = Object.freeze({ attachState, refresh, hasPro: () => refresh(false), updateUI, select, purchase, open, close, restore, manage, setStatus, cancelPendingCheckout });
  window.onGooglePlayEntitlementChanged = () => refresh(true);
  window.onGooglePlayPricesLoaded = () => { refresh(false); updateUI(); };
  window.onGooglePlayPurchaseSuccess = () => { refresh(true); setStatus(isPro() ? 'billing_restored' : statusMessage()); if (isPro()) close(); };
  window.onGooglePlayPurchaseCancelled = () => setStatus('billing_canceled');
  window.onGooglePlayCheckoutPreparationCancelled = requestId => {
    if (String(requestId) === String(checkoutRequestId) && statusKey === 'billing_loading' && !restoring) setStatus('billing_canceled');
  };
  window.onGooglePlayPurchaseFailed = error => {
    refresh(false);
    setStatus(!snapshot.configured ? 'billing_not_configured' : error?.code === 'purchase_unverified' ? 'billing_unverified' : 'billing_failed');
  };
  window.onGooglePlayPurchasePending = () => setStatus('billing_pending');
  window.onGooglePlayBillingUnavailable = error => {
    refresh(false);
    setStatus(isPro() ? 'billing_active' : !snapshot.configured ? 'billing_not_configured' :
      error?.code === 'connecting' ? 'billing_loading' : ['product_unavailable', 'verification_unavailable'].includes(error?.code) ? 'billing_unavailable' : statusMessage());
  };
})();
