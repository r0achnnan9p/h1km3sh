// Recording timeline: a 24h track that visualizes where recordings exist,
// a draggable In/Out selection, and a playhead. DOM/CSS based (no canvas).
//
// All times are seconds-of-day (0..86399). 86400 maps to 100% width.

import { secondsToTimeStr } from './util.js';

const DAY = 86400;
const MIN_SEL = 1;

function rulerHtml() {
  const labels = ['00', '03', '06', '09', '12', '15', '18', '21', '24'];
  return labels.map((l) => `<span>${l}</span>`).join('');
}

// Merge near-adjacent segments so continuous coverage shows as one band.
function mergeSegments(segs, gap = 2) {
  const sorted = segs
    .filter((s) => s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startSec <= last.endSec + gap) {
      last.endSec = Math.max(last.endSec, s.endSec);
    } else {
      out.push({ startSec: s.startSec, endSec: s.endSec });
    }
  }
  return out;
}

export function createTimeline({ container, onSeek, onSelectionChange }) {
  container.classList.add('timeline');
  container.innerHTML = `
    <div class="tl-track" role="slider" aria-label="录像时间轴" tabindex="-1">
      <div class="tl-bands"></div>
      <div class="tl-selection">
        <span class="tl-handle tl-handle-in" aria-label="入点把手"></span>
        <span class="tl-handle tl-handle-out" aria-label="出点把手"></span>
      </div>
      <div class="tl-playhead"></div>
      <div class="tl-hover"></div>
      <div class="tl-tooltip"></div>
    </div>
    <div class="tl-ruler">${rulerHtml()}</div>
  `;

  const track = container.querySelector('.tl-track');
  const bandsEl = container.querySelector('.tl-bands');
  const selEl = container.querySelector('.tl-selection');
  const playEl = container.querySelector('.tl-playhead');
  const hoverEl = container.querySelector('.tl-hover');
  const tipEl = container.querySelector('.tl-tooltip');

  let inSec = 0;
  let outSec = 0;
  let enabled = false;
  let drag = null;

  const pct = (sec) => (sec / DAY) * 100;

  function secFromEvent(e) {
    const r = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.min(DAY - 1, Math.max(0, Math.round(frac * DAY)));
  }

  function renderSelection() {
    selEl.style.left = pct(inSec) + '%';
    selEl.style.width = Math.max(0, pct(outSec - inSec)) + '%';
  }

  function setPlayhead(sec) {
    playEl.style.left = pct(sec) + '%';
  }

  function showTooltip(sec, clientX) {
    const r = track.getBoundingClientRect();
    const x = Math.min(r.width, Math.max(0, clientX - r.left));
    hoverEl.style.left = x + 'px';
    tipEl.style.left = x + 'px';
    tipEl.textContent = secondsToTimeStr(sec);
    hoverEl.classList.add('visible');
    tipEl.classList.add('visible');
  }
  function hideTooltip() {
    hoverEl.classList.remove('visible');
    tipEl.classList.remove('visible');
  }

  function onPointerDown(e) {
    if (!enabled) return;
    track.setPointerCapture?.(e.pointerId);
    const sec = secFromEvent(e);
    const t = e.target;

    if (t.classList.contains('tl-handle-in')) {
      drag = { mode: 'in' };
    } else if (t.classList.contains('tl-handle-out')) {
      drag = { mode: 'out' };
    } else if (t === selEl) {
      drag = { mode: 'move', offset: sec - inSec, dur: outSec - inSec };
    } else {
      drag = { mode: 'seek' };
      onSeek?.(sec);
      setPlayhead(sec);
    }
    applyDrag(e, sec);
  }

  function applyDrag(e, sec) {
    if (!drag) return;
    if (drag.mode === 'in') {
      inSec = Math.min(sec, outSec - MIN_SEL);
      inSec = Math.max(0, inSec);
      renderSelection();
      setPlayhead(inSec);
      onSeek?.(inSec);
      onSelectionChange?.({ inSec, outSec });
    } else if (drag.mode === 'out') {
      outSec = Math.max(sec, inSec + MIN_SEL);
      outSec = Math.min(DAY - 1, outSec);
      renderSelection();
      setPlayhead(outSec);
      onSeek?.(outSec);
      onSelectionChange?.({ inSec, outSec });
    } else if (drag.mode === 'move') {
      let newIn = sec - drag.offset;
      newIn = Math.max(0, Math.min(newIn, DAY - 1 - drag.dur));
      inSec = newIn;
      outSec = newIn + drag.dur;
      renderSelection();
      setPlayhead(inSec);
      onSeek?.(inSec);
      onSelectionChange?.({ inSec, outSec });
    } else {
      setPlayhead(sec);
      onSeek?.(sec);
    }
  }

  function onPointerMove(e) {
    if (drag) {
      applyDrag(e, secFromEvent(e));
    } else if (enabled) {
      showTooltip(secFromEvent(e), e.clientX);
    }
  }

  function onPointerUp(e) {
    if (drag) {
      track.releasePointerCapture?.(e.pointerId);
      drag = null;
    }
  }

  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove);
  track.addEventListener('pointerup', onPointerUp);
  track.addEventListener('pointercancel', onPointerUp);
  track.addEventListener('pointerleave', () => { if (!drag) hideTooltip(); });

  return {
    setRecordings(segments) {
      const bands = mergeSegments(segments || []);
      bandsEl.innerHTML = bands
        .map((b) => `<span class="tl-band" style="left:${pct(b.startSec)}%;width:${pct(b.endSec - b.startSec)}%"></span>`)
        .join('');
    },
    setPlayhead,
    setSelection(i, o) {
      inSec = Math.max(0, Math.min(i, DAY - 1));
      outSec = Math.max(inSec + MIN_SEL, Math.min(o, DAY - 1));
      renderSelection();
    },
    getSelection() {
      return { inSec, outSec };
    },
    setEnabled(on) {
      enabled = !!on;
      container.classList.toggle('tl-disabled', !enabled);
      if (!enabled) hideTooltip();
    },
  };
}
