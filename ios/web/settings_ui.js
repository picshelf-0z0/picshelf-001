/* Settings presentation and Google Play update controls. No APK URLs or simulated updates. */
(() => {
  'use strict';
  let snapshot = { status: 'idle', distribution: 'other' };
  let checkedManually = false, openWhenReady = false, notificationRequested = false, lastCopy = '';
  const t = (key, params) => window.t(key, params);
  const byId = id => document.getElementById(id);
  const setText = (id, value) => { const node = byId(id); if (node) node.textContent = value; };
  const number = value => new Intl.NumberFormat(document.documentElement.lang || 'en').format(value);
  const modalStates = ['available', 'downloading', 'downloaded', 'installing'];
  function read() {
    try {
      const value = JSON.parse(window.AndroidApp?.getAppUpdateState?.() || 'null');
      if (value && typeof value === 'object' && typeof value.status === 'string') return value;
    } catch (_) {}
    return { status: 'unavailable', distribution: 'other', notificationsEnabled: false };
  }
  function statusText() {
    const status = snapshot.status;
    if (status === 'downloading') {
      const percent = progress();
      return percent === null ? t('update_downloading') : t('updates_status_downloading', { percent: number(percent) });
    }
    if (status === 'unavailable' && snapshot.distribution !== 'google_play') return t('updates_status_play_required');
    const allowed = ['idle', 'checking', 'available', 'up_to_date', 'downloaded', 'installing', 'canceled', 'unavailable', 'failed'];
    return t('updates_status_' + (allowed.includes(status) ? status : 'unavailable'), { version: version() });
  }
  function version() { return typeof snapshot.versionName === 'string' && snapshot.versionName ? snapshot.versionName : t('updates_unknown_version'); }
  function progress() {
    const done = snapshot.bytesDownloaded, total = snapshot.totalBytes;
    return Number.isFinite(done) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, Math.floor(done / total * 100))) : null;
  }
  function notice() {
    if (snapshot.notificationStatus === 'permission_denied') return t('updates_notice_permission_required');
    if (snapshot.notificationStatus === 'unavailable') return t('updates_notice_unavailable');
    return t(snapshot.notificationsEnabled ? 'updates_notice_enabled' : 'updates_notice_disabled');
  }
  function sendNotificationCopy() {
    const copy = JSON.stringify({ channelName: t('updates_notification_channel'), title: t('updates_notification_title'), body: t('updates_notification_body') });
    if (copy === lastCopy || typeof window.AndroidApp?.setAppUpdateNotificationCopy !== 'function') return;
    try { window.AndroidApp.setAppUpdateNotificationCopy(copy); lastCopy = copy; } catch (_) {}
  }
  function render() {
    setText('settingsAppVersionText', t('settings_app_version', { version: version() }));
    setText('settingsUpdateStatusDesc', statusText());
    const checkButton = byId('settingsCheckUpdateBtn');
    if (checkButton) {
      checkButton.disabled = snapshot.status === 'checking' || snapshot.status === 'installing' || snapshot.flowPending === true;
      const span = checkButton.querySelector('span');
      if (span) {
        // Dynamic actions must survive language changes without reverting to Check Now.
        span.removeAttribute('data-i18n');
        const action = snapshot.status === 'downloaded' ? 'restart' : checkedManually && ['unavailable', 'failed'].includes(snapshot.status) ? 'store' : 'check';
        span.textContent = t('updates_action_' + action);
      }
    }
    const toggle = byId('pushUpdatesToggle');
    if (toggle) {
      toggle.checked = snapshot.notificationsEnabled === true;
      toggle.disabled = snapshot.permissionPending === true || snapshot.notificationStatus === 'requesting_permission';
    }
    setText('settingsNotificationStatus', snapshot.notificationStatus === 'requesting_permission' ? t('updates_notice_permission_required') : notice());
    const badge = byId('updateLatestVersionBadge');
    if (badge) badge.textContent = Number.isInteger(snapshot.availableVersionCode) && snapshot.availableVersionCode > 0
      ? t('updates_available_build', { build: number(snapshot.availableVersionCode) }) : t('updates_version_label', { version: version() });
    setText('updateReleaseNotesList', t('updates_details'));
    const percent = progress();
    const progressBox = byId('updateDownloadProgressBox');
    if (progressBox) progressBox.style.display = snapshot.status === 'downloading' && percent !== null ? 'block' : 'none';
    const bar = byId('updateDownloadProgressBar');
    if (bar) bar.style.width = (percent ?? 0) + '%';
    setText('updateDownloadPercentText', percent === null ? '' : number(percent) + '%');
    const installButton = byId('startUpdateInstallBtn');
    if (installButton) {
      installButton.disabled = ['checking', 'downloading', 'installing'].includes(snapshot.status) || snapshot.flowPending === true;
      const label = installButton.querySelector('span');
      if (label) { label.removeAttribute('data-i18n'); label.textContent = t('updates_action_' + (snapshot.status === 'downloaded' ? 'restart' : 'install')); }
    }
    sendNotificationCopy();
  }
  function refresh() {
    snapshot = read(); render();
    if (openWhenReady && snapshot.status !== 'checking') {
      openWhenReady = false;
      if (modalStates.includes(snapshot.status)) open();
    }
    if (notificationRequested && !snapshot.permissionPending && snapshot.notificationStatus !== 'requesting_permission') {
      notificationRequested = false; window.showToast?.(notice());
    }
    return snapshot;
  }
  function unavailable() { snapshot = { ...snapshot, status: 'unavailable' }; render(); }
  function check(manual = false) {
    refresh();
    if (['checking', 'installing'].includes(snapshot.status)) return;
    if (manual && modalStates.includes(snapshot.status)) { open(); return; }
    if (manual && checkedManually && ['unavailable', 'failed'].includes(snapshot.status)) {
      try { if (typeof window.AndroidApp?.openGooglePlayListing === 'function') { window.AndroidApp.openGooglePlayListing(); return; } } catch (_) {}
      unavailable(); return;
    }
    checkedManually ||= manual;
    openWhenReady = manual;
    if (typeof window.AndroidApp?.checkForAppUpdates !== 'function') { openWhenReady = false; unavailable(); return; }
    snapshot = { ...snapshot, status: 'checking' }; render();
    try { window.AndroidApp.checkForAppUpdates(!!manual); } catch (_) { openWhenReady = false; unavailable(); }
  }
  function toggleNotifications(enabled) {
    notificationRequested = true;
    try {
      if (enabled && snapshot.notificationStatus === 'permission_denied' && typeof window.AndroidApp?.openAppUpdateNotificationSettings === 'function') {
        window.AndroidApp.openAppUpdateNotificationSettings(); notificationRequested = false; return;
      }
      if (typeof window.AndroidApp?.setPushUpdatesEnabled === 'function') { window.AndroidApp.setPushUpdatesEnabled(!!enabled); return; }
    } catch (_) {}
    snapshot = { ...snapshot, notificationsEnabled: false, notificationStatus: 'unavailable' };
    notificationRequested = false; render(); window.showToast?.(notice());
  }
  function open() { if (!modalStates.includes(snapshot.status)) return; render(); const modal = byId('appUpdateModal'); if (modal) modal.style.display = 'flex'; }
  function close() { const modal = byId('appUpdateModal'); if (modal) modal.style.display = 'none'; }
  function install() {
    refresh();
    if (!['available', 'downloaded'].includes(snapshot.status)) return;
    try {
      const method = snapshot.status === 'downloaded' ? 'completeGooglePlayUpdate' : 'startGooglePlayUpdate';
      if (typeof window.AndroidApp?.[method] === 'function') { window.AndroidApp[method](); return; }
    } catch (_) {}
    unavailable(); close();
  }
  window.PicShelfSettings = Object.freeze({ refresh, render, check, toggleNotifications, open, close, install });
  let autoRestartOffered = false;
  window.onGooglePlayUpdateStateChanged = () => {
    refresh();
    if (!modalStates.includes(snapshot.status) && snapshot.status !== 'checking') close();
    // An update Play started on app open finished downloading in the background: offer the restart once.
    if (snapshot.status === 'downloaded' && snapshot.autoFlow === true && !autoRestartOffered) { autoRestartOffered = true; open(); }
  };
  // Native asks before an automatic update restarts PicShelf after a warm return:
  // never cut off a running download, share, library save or backup.
  window.PicShelfAppUpdateGate = () => {
    try {
      if (window.DownloadManager?.hasWaitingDownloads?.()) return false;
      if (window.MediaShare?.isOpen?.()) return false;
      if (window.LibraryStore?.getStatus?.().pending) return false;
      if (window.PicShelfBackup?.busy?.()) return false;
    } catch (_) {}
    return true;
  };
  document.addEventListener('DOMContentLoaded', refresh, { once: true });
})();
