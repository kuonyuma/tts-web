/**
 * Sidebar Resizer Module
 * Allows dynamic resizing of left (conversations) and right (AI reading assistant) sidebars,
 * with bounded constraints, keyboard accessibility, double-click reset, and localStorage persistence.
 */

export const DEFAULT_LEFT_WIDTH = 250;
export const MIN_LEFT_WIDTH = 180;
export const MAX_LEFT_WIDTH = 480;

export const DEFAULT_RIGHT_WIDTH = 345;
export const MIN_RIGHT_WIDTH = 260;
export const MAX_RIGHT_WIDTH = 600;

export const MIN_CENTER_WIDTH = 360;

export const LEFT_STORAGE_KEY = 'tts_sidebar_left_width';
export const RIGHT_STORAGE_KEY = 'tts_sidebar_right_width';

const narrow = window.matchMedia('(max-width: 1100px)');

function readSavedWidth(key, defaultWidth, min, max) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultWidth;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(min, Math.min(max, parsed));
    }
  } catch (_) {}
  return defaultWidth;
}

let leftWidth = readSavedWidth(LEFT_STORAGE_KEY, DEFAULT_LEFT_WIDTH, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH);
let rightWidth = readSavedWidth(RIGHT_STORAGE_KEY, DEFAULT_RIGHT_WIDTH, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH);

let isLeftOpenFn = () => true;
let isRightOpenFn = () => true;

export function getSidebarWidth(side) {
  return side === 'left' ? leftWidth : rightWidth;
}

export function applyWidths() {
  document.documentElement.style.setProperty('--sidebar-left-width', `${leftWidth}px`);
  document.documentElement.style.setProperty('--sidebar-right-width', `${rightWidth}px`);
  if (document.body) {
    document.body.style.setProperty('--sidebar-left-width', `${leftWidth}px`);
    document.body.style.setProperty('--sidebar-right-width', `${rightWidth}px`);
  }

  const leftResizer = document.getElementById('leftResizer');
  if (leftResizer) {
    leftResizer.setAttribute('aria-valuenow', String(Math.round(leftWidth)));
  }

  const rightResizer = document.getElementById('rightResizer');
  if (rightResizer) {
    rightResizer.setAttribute('aria-valuenow', String(Math.round(rightWidth)));
  }
}

export function setSidebarWidth(side, width, save = true) {
  const shell = document.querySelector('.chat-shell');
  const shellWidth = shell ? shell.clientWidth : window.innerWidth;

  if (side === 'left') {
    const otherWidth = isRightOpenFn() ? rightWidth : 0;
    const maxAllowed = Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, shellWidth - otherWidth - MIN_CENTER_WIDTH));
    leftWidth = Math.max(MIN_LEFT_WIDTH, Math.min(maxAllowed, Math.round(width)));
    if (save) {
      try { localStorage.setItem(LEFT_STORAGE_KEY, String(leftWidth)); } catch (_) {}
    }
  } else {
    const otherWidth = isLeftOpenFn() ? leftWidth : 0;
    const maxAllowed = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, shellWidth - otherWidth - MIN_CENTER_WIDTH));
    rightWidth = Math.max(MIN_RIGHT_WIDTH, Math.min(maxAllowed, Math.round(width)));
    if (save) {
      try { localStorage.setItem(RIGHT_STORAGE_KEY, String(rightWidth)); } catch (_) {}
    }
  }
  applyWidths();
  return side === 'left' ? leftWidth : rightWidth;
}

export function resetSidebarWidth(side) {
  const defaultWidth = side === 'left' ? DEFAULT_LEFT_WIDTH : DEFAULT_RIGHT_WIDTH;
  return setSidebarWidth(side, defaultWidth, true);
}

export function adjustForAvailableSpace() {
  if (narrow.matches) return;
  const shell = document.querySelector('.chat-shell');
  const shellWidth = shell ? shell.clientWidth : window.innerWidth;
  const activeLeft = isLeftOpenFn() ? leftWidth : 0;
  const activeRight = isRightOpenFn() ? rightWidth : 0;
  const needed = activeLeft + activeRight + MIN_CENTER_WIDTH;

  if (needed > shellWidth) {
    let excess = needed - shellWidth;
    if (isRightOpenFn() && rightWidth > MIN_RIGHT_WIDTH) {
      const shrinkRight = Math.min(excess, rightWidth - MIN_RIGHT_WIDTH);
      rightWidth -= shrinkRight;
      excess -= shrinkRight;
    }
    if (excess > 0 && isLeftOpenFn() && leftWidth > MIN_LEFT_WIDTH) {
      const shrinkLeft = Math.min(excess, leftWidth - MIN_LEFT_WIDTH);
      leftWidth -= shrinkLeft;
    }
    applyWidths();
  }
}

export function initSidebarResizers({ isLeftOpen = () => true, isRightOpen = () => true } = {}) {
  isLeftOpenFn = isLeftOpen;
  isRightOpenFn = isRightOpen;

  applyWidths();
  adjustForAvailableSpace();

  setupResizer('left', 'leftResizer', 'conversationSidebar');
  setupResizer('right', 'rightResizer', 'explainSection');

  window.addEventListener('resize', () => {
    adjustForAvailableSpace();
  });
}

function setupResizer(side, resizerId, panelId) {
  const resizer = document.getElementById(resizerId);
  if (!resizer) return;

  const min = side === 'left' ? MIN_LEFT_WIDTH : MIN_RIGHT_WIDTH;
  const max = side === 'left' ? MAX_LEFT_WIDTH : MAX_RIGHT_WIDTH;
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-valuemin', String(min));
  resizer.setAttribute('aria-valuemax', String(max));
  resizer.setAttribute('aria-valuenow', String(Math.round(side === 'left' ? leftWidth : rightWidth)));
  resizer.setAttribute('aria-controls', panelId);
  resizer.setAttribute('tabindex', '0');

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  const onPointerDown = (e) => {
    if (e.button !== 0 || narrow.matches) return;
    isDragging = true;
    startX = e.clientX;
    startWidth = side === 'left' ? leftWidth : rightWidth;

    try {
      resizer.setPointerCapture(e.pointerId);
    } catch (_) {}

    document.body.classList.add('is-resizing', `is-resizing-${side}`);
    resizer.classList.add('is-active');
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const targetWidth = side === 'left' ? (startWidth + dx) : (startWidth - dx);
    setSidebarWidth(side, targetWidth, false);
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    try {
      resizer.releasePointerCapture(e.pointerId);
    } catch (_) {}

    document.body.classList.remove('is-resizing', `is-resizing-${side}`);
    resizer.classList.remove('is-active');

    // Save final width
    const current = side === 'left' ? leftWidth : rightWidth;
    try {
      localStorage.setItem(side === 'left' ? LEFT_STORAGE_KEY : RIGHT_STORAGE_KEY, String(current));
    } catch (_) {}
  };

  resizer.addEventListener('pointerdown', onPointerDown);
  resizer.addEventListener('pointermove', onPointerMove);
  resizer.addEventListener('pointerup', onPointerUp);
  resizer.addEventListener('pointercancel', onPointerUp);

  // Double-click to reset to default
  resizer.addEventListener('dblclick', (e) => {
    e.preventDefault();
    resetSidebarWidth(side);
  });

  // Keyboard accessibility
  resizer.addEventListener('keydown', (e) => {
    if (narrow.matches) return;
    const step = e.shiftKey ? 40 : 10;
    let handled = false;

    if (side === 'left') {
      if (e.key === 'ArrowRight') {
        setSidebarWidth('left', leftWidth + step);
        handled = true;
      } else if (e.key === 'ArrowLeft') {
        setSidebarWidth('left', leftWidth - step);
        handled = true;
      }
    } else {
      if (e.key === 'ArrowLeft') {
        setSidebarWidth('right', rightWidth + step);
        handled = true;
      } else if (e.key === 'ArrowRight') {
        setSidebarWidth('right', rightWidth - step);
        handled = true;
      }
    }

    if (e.key === 'Home') {
      setSidebarWidth(side, side === 'left' ? MIN_LEFT_WIDTH : MIN_RIGHT_WIDTH);
      handled = true;
    } else if (e.key === 'End') {
      setSidebarWidth(side, side === 'left' ? MAX_LEFT_WIDTH : MAX_RIGHT_WIDTH);
      handled = true;
    } else if (e.key === 'Enter' || e.key === ' ') {
      resetSidebarWidth(side);
      handled = true;
    }

    if (handled) {
      e.preventDefault();
    }
  });
}
