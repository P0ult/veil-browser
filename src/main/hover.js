'use strict';

/**
 * Is the pointer reaching for the chrome?
 *
 * Kept apart from the polling in index.js because the polling is untestable -
 * it asks the OS where the mouse is - while the decision it makes is not, and
 * the decision is the part that is easy to get subtly wrong.
 *
 * Two things are folded together here:
 *
 *   - A band along the top and left edges. Both, because the tabs live on top
 *     in one layout and down the left in the other, and because a band is
 *     something to aim at where a hairline is something to hunt for.
 *   - The chrome's own area, whenever it is showing. Without this the chrome
 *     would close under a pointer resting on the far side of a wide toolbar.
 *
 * All coordinates are relative to the window's content area.
 */
function reachingForChrome(p) {
  const { x, y, width, height } = p;
  if (!(width > 0) || !(height > 0)) return false;
  if (x < 0 || y < 0 || x >= width || y >= height) return false;   // not over the window

  const band = p.band > 0 ? p.band : 0;
  const top = Math.max(p.top || 0, band);
  const left = Math.max(p.left || 0, band);
  return y < top || x < left;
}

module.exports = { reachingForChrome };
