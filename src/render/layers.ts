/**
 * Covering-layer stacking constants.
 *
 * Each of the four roots (mapPieces / zomboss / path / event) has an
 * explicit z-index and establishes its own CSS stacking context, so z-index
 * values *inside* one root never compete with another root's internals.
 *
 * Doodads are event nodes (m_eventType === 'doodad') and share the Event layer
 * with other non-zomboss events: sorted by m_drawLayer container, then y, then x.
 */

export const PARALLAX_LAYERS = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].sort(
    (a, b) => b - a
);

export const DRAW_LAYERS = Array.from({ length: 47 }, (_, i) => -36 + i);

export function getGroupKey(parallaxLayer: number, drawLayer: number): string {
  const safePl = PARALLAX_LAYERS.includes(parallaxLayer) ? parallaxLayer : 0;
  const safeDl = DRAW_LAYERS.includes(drawLayer) ? drawLayer : 0;
  return `${safePl}_${safeDl}`;
}

export const LAYER_Z = {
  mapPieces: 200,
  zomboss: 400,
  path: 600,
  event: 800,
} as const;