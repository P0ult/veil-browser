'use strict';

/**
 * Where the three views go.
 *
 * Veil draws in three native views stacked in one window: the page, the
 * toolbar, and - when tabs are vertical - the tab rail. This works out their
 * rectangles, and it is kept apart from index.js because it is pure
 * arithmetic and because getting it wrong is invisible until something is
 * unclickable or hidden behind something else.
 *
 * Two arrangements:
 *
 *   docked   - the chrome takes its space and the page gets what is left.
 *              Nothing overlaps.
 *   floating - the page has the whole window and the chrome slides in over
 *              the top of it. `toolbarShown` and `railShown` run 0 to 1, and
 *              at 0 the view sits entirely off-screen, where it can neither
 *              be seen nor swallow a click meant for the page.
 *
 * A view is `null` when it should not exist at all - the rail in horizontal
 * tab mode - as distinct from being present but scrolled out of sight.
 */
function computeLayout(o) {
  const w = Math.max(0, Math.round(o.width || 0));
  const h = Math.max(0, Math.round(o.height || 0));
  const side = o.mode === 'side';
  const toolbarH = Math.max(0, Math.round(o.toolbarH || 0));
  const railW = side ? Math.max(0, Math.round(o.railW || 0)) : 0;

  if (!o.floating) {
    return {
      page: { x: railW, y: toolbarH, width: Math.max(0, w - railW), height: Math.max(0, h - toolbarH) },
      chrome: { x: railW, y: 0, width: Math.max(0, w - railW), height: toolbarH },
      rail: side ? { x: 0, y: 0, width: railW, height: h } : null
    };
  }

  const clamp01 = (v) => (v > 1 ? 1 : v < 0 ? 0 : v || 0);
  const railOut = Math.round(railW * clamp01(o.railShown));
  const toolbarOut = Math.round(toolbarH * clamp01(o.toolbarShown));

  return {
    // The page never moves while the chrome comes and goes. That is the whole
    // point of floating: no frame of the animation costs a document relayout.
    page: { x: 0, y: 0, width: w, height: h },
    // The toolbar starts to the right of however much rail is showing, so the
    // two do not overlap in the corner when both are out.
    chrome: { x: railOut, y: toolbarOut - toolbarH, width: Math.max(0, w - railOut), height: toolbarH },
    rail: side ? { x: railOut - railW, y: 0, width: railW, height: h } : null
  };
}

/**
 * What to do about a width the rail has just reported.
 *
 * The rail sends two numbers on every frame of its open-and-close animation:
 * how wide it is now, and how wide it means to be when nothing is hovering it.
 * Telling those apart is the difference between a smooth animation and a
 * laggy one:
 *
 *   'rail-only'  the rail is peeking open over the top of everything else.
 *                Only its own rectangle changes. This is most of the frames.
 *   'full'       its resting width really changed - the sidebar was collapsed,
 *                or its width setting edited - so the page and the toolbar
 *                have to move with it.
 *   'none'       nothing has changed since the last report.
 *
 * Every frame used to be treated as 'full', which relaid out the rail, the
 * toolbar and every page view sixty times a second for an animation in which
 * one edge moves.
 *
 * @param {object} current { railW, peek } as the window has them now
 * @param {number} width   what the rail says it is
 * @param {number} resting what the rail says it will settle at
 */
function railUpdate(current, width, resting) {
  const clamp = (v) => Math.max(0, Math.min(600, Math.round(Number(v) || 0)));
  const now = clamp(width);
  const rest = clamp(resting === undefined || resting === null ? width : resting);
  const peek = Math.max(0, now - rest);

  const wasW = clamp(current && current.railW);
  const wasPeek = Math.max(0, Math.round(Number(current && current.peek) || 0));

  if (rest !== wasW) return { mode: 'full', railW: rest, peek };
  if (peek !== wasPeek) return { mode: 'rail-only', railW: rest, peek };
  return { mode: 'none', railW: rest, peek };
}

module.exports = { computeLayout, railUpdate };
