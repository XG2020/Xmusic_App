'use strict';

const title = document.getElementById('song-title');
const artist = document.getElementById('song-artist');
const toggle = document.getElementById('toggle');
const favorite = document.getElementById('favorite');
const mute = document.getElementById('mute');
const volume = document.getElementById('volume');
const lyrics = document.getElementById('lyrics');
const buttons = [...document.querySelectorAll('[data-command]')];
const controls = [...document.querySelectorAll('button, input')];
let adjustingVolume = false;

function setLabel(button, label) {
  button.setAttribute('aria-label', label);
  button.title = label;
}
function paintVolume(value) {
  volume.value = String(value);
  volume.style.setProperty('--volume-fill', `${value}%`);
  volume.setAttribute('aria-valuetext', `${value}%`);
}
function render(state) {
  if (!state || typeof state !== 'object') return;
  title.textContent = typeof state.title === 'string' ? state.title : 'Xmusic';
  title.title = title.textContent;
  artist.textContent = typeof state.artist === 'string' ? state.artist : '';
  artist.title = artist.textContent;
  artist.hidden = !artist.textContent;
  setLabel(toggle, state.playing ? '暂停' : '播放');
  toggle.dataset.playing = String(state.playing === true);
  for (const button of [toggle, document.getElementById('previous'), document.getElementById('next')]) {
    button.disabled = state.hasQueue !== true;
  }
  favorite.disabled = state.hasTrack !== true;
  favorite.setAttribute('aria-pressed', String(state.favorite === true));
  setLabel(favorite, state.favorite ? '取消收藏' : '收藏到我喜欢');
  lyrics.setAttribute('aria-checked', String(state.visible === true));
  mute.setAttribute('aria-pressed', String(state.muted === true));
  mute.dataset.silent = String(state.muted === true || state.volume === 0);
  setLabel(mute, state.muted ? '取消静音' : '静音');
  if (!adjustingVolume && typeof state.volume === 'number' && Number.isFinite(state.volume)) {
    paintVolume(state.muted ? 0 : Math.round(Math.max(0, Math.min(1, state.volume)) * 100));
  }
}
let changed = false;
const unsubscribe = window.trayMenu.onSnapshot(state => {changed = true; render(state);});
window.trayMenu.getSnapshot().then(state => {if (!changed) render(state);}).catch(() => {});
for (const button of buttons) button.addEventListener('click', () => window.trayMenu.command(button.dataset.command));
volume.addEventListener('pointerdown', () => {adjustingVolume = true;});
window.addEventListener('pointerup', () => {adjustingVolume = false;});
window.addEventListener('pointercancel', () => {adjustingVolume = false;});
volume.addEventListener('blur', () => {adjustingVolume = false;});
volume.addEventListener('input', () => {
  const value = Number(volume.value);
  paintVolume(value);
  window.trayMenu.command('volume', value / 100);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {event.preventDefault(); window.trayMenu.command('hide'); return;}
  // The slider keeps its native Arrow, Home and End behavior, including keyboard volume changes.
  if (document.activeElement === volume || event.altKey || event.ctrlKey || event.metaKey) return;
  const enabled = controls.filter(control => !control.disabled);
  const index = enabled.indexOf(document.activeElement);
  let next;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % enabled.length;
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index < 0 ? enabled.length - 1 : index + enabled.length - 1) % enabled.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = enabled.length - 1;
  if (next !== undefined) {event.preventDefault(); enabled[next]?.focus();}
});
window.addEventListener('focus', () => (toggle.disabled ? document.getElementById('queue') : toggle).focus());
window.addEventListener('unload', unsubscribe, {once: true});
