'use strict';
const currentLine = document.getElementById('current-line');
const nextLine = document.getElementById('next-line');
const title = document.getElementById('song-title');
const toggle = document.getElementById('toggle');
const panel = document.getElementById('lyrics-panel');
const lyricLines = document.getElementById('lyric-lines');
const measureCurrent = document.getElementById('measure-current');
const measureNext = document.getElementById('measure-next');
const copyNotice = document.getElementById('copy-notice');
const toolbar = document.getElementById('floating-toolbar');
const reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let content = null;
let receivedAt = 0;
let frame = 0;
let lineKey = '';
let wordElements = [];
let timings = [];
let layoutId = 0;
let layoutFrame = 0;
let layoutKey = '';
let sizeReportKey = '';
let availableWidth = 0;
let pendingTransition = null;
let outgoingLine = null;
let lineAnimations = [];
let unloaded = false;
let copyNoticeTimer = 0;
let copyRequest = 0;
let pointerInside = false;
let nativePointerKnown = false;
let pointerInitialized = false;
let controlsFocused = false;
let keyboardFocusMode = false;
let controlsShown = false;
let locked = false;
let hideControlsTimer = 0;
const styled = {};
function setStyle(name, value) {
  if (styled[name] === value) return;
  document.documentElement.style.setProperty(name, value);
  styled[name] = value;
}
function showControls(show) {
  controlsShown = show;
  document.body.classList.toggle('controls-visible', show);
}
function refreshControls() {
  if (locked || pointerInside || controlsFocused) {
    clearTimeout(hideControlsTimer);
    hideControlsTimer = 0;
    showControls(!locked);
    return;
  }
  if (controlsShown && !hideControlsTimer) hideControlsTimer = setTimeout(() => {
    hideControlsTimer = 0;
    if (!pointerInside && !controlsFocused) showControls(false);
  }, 700);
}
function receivePointer(inside, native = false) {
  pointerInitialized = true;
  if (native) nativePointerKnown = true;
  pointerInside = inside;
  refreshControls();
}
const mouseEnter = () => {if (!nativePointerKnown) receivePointer(true);};
const mouseLeave = () => {if (!nativePointerKnown) receivePointer(false);};
const withinControls = target => !!target && (!!toolbar?.contains(target) || !!panel?.contains(target));
const focusIn = event => {controlsFocused = keyboardFocusMode && withinControls(event.target); refreshControls();};
const focusOut = event => {
  controlsFocused = keyboardFocusMode && withinControls(event.relatedTarget);
  refreshControls();
};
const keyboardInput = event => {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
  keyboardFocusMode = true;
  controlsFocused = withinControls(document.activeElement);
  refreshControls();
};
const pointerInput = () => {
  keyboardFocusMode = false;
  controlsFocused = false;
  refreshControls();
};
const blur = () => {controlsFocused = false; refreshControls();};
function cancelLineTransition() {
  lineAnimations.forEach(animation => animation.cancel());
  lineAnimations = [];
  outgoingLine?.remove();
  outgoingLine = null;
  pendingTransition = null;
}
function syncLineAnimation() {
  lineAnimations.forEach(animation => {
    if (content?.playing && !content.loading) animation.play();
    else animation.pause();
  });
}
function startLineTransition() {
  const transition = pendingTransition;
  pendingTransition = null;
  if (!transition || !content?.singleLine || !content.playing || content.loading || reducedMotion?.matches) return;
  const distance = currentLine.getBoundingClientRect().width + 18;
  const options = {duration: 650, easing: 'cubic-bezier(.22,.61,.36,1)'};
  const offset = transition.direction * distance;
  lineAnimations = [currentLine.animate([
    {transform: `translateX(${offset}px)`, opacity: transition.continuous ? 1 : 0},
    {transform: 'translateX(0)', opacity: 1},
  ], options)];
  if (content.nextLine) lineAnimations.push(nextLine.animate([
    {transform: `translateX(${offset}px)`, opacity: transition.direction < 0 && transition.previousLine === content.nextLine ? .65 : 0},
    {transform: 'translateX(0)', opacity: .65},
  ], options));
  if (transition.outgoing) {
    outgoingLine = transition.outgoing;
    outgoingLine.style.width = `${currentLine.getBoundingClientRect().width}px`;
    lyricLines.append(outgoingLine);
    outgoingLine.scrollLeft = transition.outgoingScroll;
    lineAnimations.push(outgoingLine.animate([
      {transform: 'translateX(0)', opacity: 1},
      {transform: `translateX(${-offset}px)`, opacity: 0},
    ], options));
  }
  lineAnimations[0].onfinish = () => cancelLineTransition();
}
function measureLayout() {
  layoutFrame = 0;
  if (unloaded || !panel || !content) return;
  // Measure at the chosen font size; dragging the background must never alter
  // typography. Only lines wider than the monitor wrap at its maximum width.
  for (const measure of [measureCurrent, measureNext]) {
    measure.style.width = 'max-content';
    measure.style.whiteSpace = 'pre';
    measure.style.overflowWrap = 'normal';
  }
  const currentWidth = measureCurrent.getBoundingClientRect().width;
  const nextWidth = content.nextLine ? measureNext.getBoundingClientRect().width : 0;
  const rect = panel.getBoundingClientRect();
  const hasNext = !!content.nextLine;
  const sideBySide = content.singleLine && hasNext;
  const width = Math.ceil((sideBySide ? Math.max(currentWidth, nextWidth) * 2 + 18 : Math.max(currentWidth, nextWidth)) + 26);
  const screenWidth = availableWidth || rect.width;
  const wrapped = width > screenWidth;
  const slotWidth = Math.max(1, sideBySide ? (screenWidth - 44) / 2 : screenWidth - 26);
  document.body.classList.toggle('screen-wrapped', wrapped);
  if (wrapped) for (const measure of [measureCurrent, measureNext]) {
    measure.style.width = `${slotWidth}px`;
    measure.style.whiteSpace = 'pre-wrap';
    measure.style.overflowWrap = 'anywhere';
  }
  const gap = !content.singleLine && hasNext ? 3 : 0;
  const currentHeight = measureCurrent.getBoundingClientRect().height || content.fontSize * 1.3;
  const nextHeight = hasNext ? measureNext.getBoundingClientRect().height || content.fontSize * 1.3 * (content.singleLine ? 1 : .65) : 0;
  const height = Math.ceil(50 + gap + (sideBySide ? Math.max(currentHeight, nextHeight) : currentHeight + nextHeight));
  const report = {layoutId, width, height};
  const reportKey = JSON.stringify(report);
  if (reportKey !== sizeReportKey) {
    sizeReportKey = reportKey;
    window.floatingLyrics.reportSize?.(report);
  }
  currentLine.scrollLeft = 0;
  nextLine.scrollLeft = 0;
  panel.dataset.fittedLayoutId = String(layoutId);
  panel.dataset.displayFontSize = String(content.fontSize);
  panel.dataset.slotWidth = String(slotWidth);
  startLineTransition();
}
function scheduleLayout() {
  if (!unloaded && panel && measureCurrent && measureNext && !layoutFrame) layoutFrame = requestAnimationFrame(measureLayout);
}
function paintProgress(now) {
  if (!content) return;
  const position = content.position + (content.playing && !content.loading ? Math.max(0, now - receivedAt) / 1000 * content.playbackRate : 0);
  wordElements.forEach((element, index) => {
    const word = timings[index];
    const progress = word.dur > 0 ? Math.max(0, Math.min(1, (position - word.start) / word.dur)) : position >= word.start ? 1 : 0;
    element.style.setProperty('--word-progress', `${progress * 100}%`);
  });
  currentLine.scrollLeft = 0;
  const last = timings[timings.length - 1];
  if (content.playing && !content.loading && last && position < last.start + last.dur) frame = requestAnimationFrame(paintProgress);
}
function render(snapshot) {
  if (!snapshot?.content) return;
  const previous = content;
  content = {...content, ...snapshot.content};
  receivedAt = performance.now();
  cancelAnimationFrame(frame);
  setStyle('--accent', content.accentColor);
  setStyle('--font-size', `${content.fontSize}px`);
  setStyle('--display-font-size', `${content.fontSize}px`);
  const family = typeof content.fontFamily === 'string' && /^[\p{L}\p{N}\p{M} ._+\-]{1,80}$/u.test(content.fontFamily.trim()) ? content.fontFamily.trim() : '';
  setStyle('--lyric-font-family', `${family ? `"${family}", ` : ''}'Segoe UI', 'Microsoft YaHei UI', sans-serif`);
  setStyle('--panel-opacity', String(content.opacity));
  setStyle('--panel-radius', `${Number.isFinite(content.borderRadius) ? Math.max(0, Math.min(40, content.borderRadius)) : 12}px`);
  setStyle('--background-image', content.backgroundImage ? `url("${content.backgroundImage}")` : 'none');
  if (typeof snapshot.locked === 'boolean') locked = snapshot.locked;
  document.body.classList.toggle('locked', locked);
  refreshControls();
  document.body.classList.toggle('single-line', content.singleLine === true);
  document.body.classList.toggle('no-next', !content.nextLine);
  title.textContent = [content.title, content.artist].filter(Boolean).join(' · ') || 'Xmusic · 桌面歌词';
  const words = content.words?.length ? content.words : content.lineEnd > content.lineStart ? [{text: content.line, start: content.lineStart, dur: content.lineEnd - content.lineStart}] : [];
  const key = JSON.stringify([content.title, content.artist, content.line, content.lineStart, words]);
  if (key !== lineKey) {
    cancelLineTransition();
    if (panel && lyricLines && previous?.singleLine && content.singleLine && content.playing && !content.loading && !reducedMotion?.matches &&
      previous.title === content.title && previous.artist === content.artist && (previous.line !== content.line || previous.lineStart !== content.lineStart) &&
      typeof currentLine.animate === 'function') {
      const direction = content.lineStart < previous.lineStart || content.position < previous.position - .05 ? -1 : 1;
      const outgoing = direction > 0 || previous.line !== content.nextLine ? currentLine.cloneNode(true) : null;
      if (outgoing) {
        outgoing.removeAttribute('id');
        outgoing.removeAttribute('aria-label');
        outgoing.removeAttribute('tabindex');
        outgoing.setAttribute('aria-hidden', 'true');
        outgoing.className = 'lyric-line-outgoing';
        outgoing.scrollLeft = currentLine.scrollLeft;
      }
      pendingTransition = {direction, outgoing, outgoingScroll: currentLine.scrollLeft, continuous: direction > 0 && previous.nextLine === content.line, previousLine: previous.line};
    }
    lineKey = key;
    currentLine.replaceChildren();
    currentLine.setAttribute('aria-label', content.line || '♪');
    wordElements = words.map(word => {
      const element = document.createElement('span');
      element.className = 'lyric-word';
      element.dataset.text = word.text;
      element.textContent = word.text;
      currentLine.append(element);
      return element;
    });
    timings = words;
    if (!words.length) currentLine.textContent = content.line || '♪';
    currentLine.scrollLeft = 0;
  }
  nextLine.textContent = content.nextLine;
  if (previous?.singleLine !== content.singleLine) cancelLineTransition();
  toggle.setAttribute('data-playing', String(content.playing));
  toggle.title = content.playing ? '暂停' : '播放';
  toggle.setAttribute('aria-label', toggle.title);
  const nextLayoutId = Number.isSafeInteger(snapshot.layoutId) && snapshot.layoutId > 0 ? snapshot.layoutId : layoutId;
  if (Number.isFinite(snapshot.availableWidth) && snapshot.availableWidth > 0) availableWidth = snapshot.availableWidth;
  const nextLayoutKey = JSON.stringify([nextLayoutId, availableWidth, content.fontSize, family, content.singleLine === true, content.line, content.nextLine]);
  if (layoutKey !== nextLayoutKey) {
    layoutKey = nextLayoutKey;
    layoutId = nextLayoutId;
    if (measureCurrent) measureCurrent.replaceChildren(...Array.from(currentLine.childNodes, node => node.cloneNode(true)));
    if (measureNext) measureNext.textContent = content.nextLine || '';
    scheduleLayout();
  } else if (pendingTransition) scheduleLayout();
  syncLineAnimation();
  paintProgress(receivedAt);
}
let receivedUpdate = false;
const unpointer = window.floatingLyrics.onPointerInside?.(inside => receivePointer(inside === true, true));
const unsubscribe = window.floatingLyrics.onSnapshot(snapshot => { receivedUpdate = true; render(snapshot); });
window.floatingLyrics.getSnapshot().then(snapshot => {
  if (typeof snapshot?.pointerInside === 'boolean') {
    // The first native hover event can precede renderer startup. Its snapshot
    // must establish the same authority over noisy drag-region DOM events.
    if (snapshot.nativePointerAvailable === true) {
      if (!nativePointerKnown) receivePointer(snapshot.pointerInside, true);
    } else if (!pointerInitialized) receivePointer(snapshot.pointerInside);
  }
  if (!receivedUpdate) render(snapshot);
  else if (content && content.backgroundImage === undefined && snapshot?.content) {
    // A clock-only update may win the initial snapshot race. Keep that newer
    // clock while recovering the image omitted from the lightweight update.
    content.backgroundImage = snapshot.content.backgroundImage;
    setStyle('--background-image', content.backgroundImage ? `url("${content.backgroundImage}")` : 'none');
  }
}).catch(() => { if (!receivedUpdate) currentLine.textContent = '歌词连接失败，请重新打开'; });
document.querySelectorAll('[data-command]').forEach(button => {
  button.addEventListener('click', () => window.floatingLyrics.command(button.dataset.command));
});
async function copyLyric(event, text) {
  if (document.body.classList.contains('locked') || !text?.trim()) return;
  event.preventDefault();
  event.stopPropagation();
  const request = ++copyRequest;
  clearTimeout(copyNoticeTimer);
  let message;
  try {
    await window.floatingLyrics.copyText(text);
    message = '已复制歌词';
  } catch (error) {message = error instanceof Error ? error.message : '复制失败，请重试。';}
  if (unloaded || request !== copyRequest || !copyNotice) return;
  copyNotice.textContent = message;
  copyNotice.hidden = false;
  copyNoticeTimer = setTimeout(() => {copyNotice.hidden = true;}, 2000);
}
currentLine.addEventListener?.('contextmenu', event => {void copyLyric(event, content?.line);});
nextLine.addEventListener?.('contextmenu', event => {void copyLyric(event, content?.nextLine);});
document.body.addEventListener?.('mouseenter', mouseEnter);
document.body.addEventListener?.('mouseleave', mouseLeave);
document.body.addEventListener?.('focusin', focusIn);
document.body.addEventListener?.('focusout', focusOut);
const resizeObserver = typeof window.ResizeObserver === 'function' && panel ? new window.ResizeObserver(scheduleLayout) : null;
resizeObserver?.observe(panel);
window.addEventListener('resize', scheduleLayout);
window.addEventListener('blur', blur);
window.addEventListener('keydown', keyboardInput, true);
window.addEventListener('pointerdown', pointerInput, true);
const motionChange = () => { if (reducedMotion?.matches) cancelLineTransition(); };
reducedMotion?.addEventListener('change', motionChange);
document.fonts?.addEventListener('loadingdone', scheduleLayout);
document.fonts?.ready.then(scheduleLayout);
window.addEventListener('unload', () => {
  unloaded = true;
  clearTimeout(copyNoticeTimer);
  clearTimeout(hideControlsTimer);
  unpointer?.();
  unsubscribe();
  cancelAnimationFrame(frame);
  cancelAnimationFrame(layoutFrame);
  cancelLineTransition();
  resizeObserver?.disconnect();
  window.removeEventListener?.('resize', scheduleLayout);
  window.removeEventListener?.('blur', blur);
  window.removeEventListener?.('keydown', keyboardInput, true);
  window.removeEventListener?.('pointerdown', pointerInput, true);
  reducedMotion?.removeEventListener('change', motionChange);
  document.fonts?.removeEventListener('loadingdone', scheduleLayout);
  document.body.removeEventListener?.('mouseenter', mouseEnter);
  document.body.removeEventListener?.('mouseleave', mouseLeave);
  document.body.removeEventListener?.('focusin', focusIn);
  document.body.removeEventListener?.('focusout', focusOut);
}, { once: true });
