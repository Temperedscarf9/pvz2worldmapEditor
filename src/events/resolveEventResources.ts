import { EventResourceDef, MapEventNode, MapEventType, WorldMapEventStatus } from '../domain/types';
import { eventNodeRuntimeMap, State } from '../core/state';
import { EventResourceCtx, stringToMapEventType } from './shared';
import { resolveLevelResources } from './resolvers/level';
import { resolvePlantResources } from './resolvers/plant';
import { resolveUpgradeResources } from './resolvers/upgrade';
import { resolveStarGateResources } from './resolvers/starGate';
import { resolveKeyGateResources } from './resolvers/keyGate';
import { resolveGiftboxResources } from './resolvers/giftbox';
import { resolvePinataResources } from './resolvers/pinata';
import { resolveDoodadResources } from './resolvers/doodad';
import { resolvePathNodeResources } from './resolvers/pathNode';

export const EVENT_RESOURCE_RESOLVERS: Partial<
    Record<MapEventType, (ctx: EventResourceCtx) => Promise<EventResourceDef[]>>
> = {
  [MapEventType.level]: resolveLevelResources,
  [MapEventType.plant]: resolvePlantResources,
  [MapEventType.plantbox]: resolvePlantResources,
  [MapEventType.upgrade]: resolveUpgradeResources,
  [MapEventType.star_gate]: resolveStarGateResources,
  [MapEventType.key_gate]: resolveKeyGateResources,
  [MapEventType.giftbox]: resolveGiftboxResources,
  [MapEventType.pinata]: resolvePinataResources,
  [MapEventType.doodad]: resolveDoodadResources,
  [MapEventType.path_node]: resolvePathNodeResources,
};

const eventResourceCache = new Map<string, Promise<EventResourceDef[]>>();

export function clearEventResourceCache(): void {
  eventResourceCache.clear();
}

/** Drop only cache entries for one eventId (avoids full-table clear on single-node edits). */
export function invalidateEventResourceCacheForNode(eventId: number | string): void {
  const prefix = String(eventId) + '_';
  for (const key of Array.from(eventResourceCache.keys())) {
    if (key.startsWith(prefix)) {
      eventResourceCache.delete(key);
    }
  }
}

export async function resolveEventResources(node: MapEventNode, worldName: string): Promise<EventResourceDef[]> {
  const eventType = stringToMapEventType(node.m_eventType);
  const runtime = eventNodeRuntimeMap.get(node);
  const status = runtime?.wmed.S ?? WorldMapEventStatus.locked;
  const resolution = State.data.textureResolution;
  const isLinear = State.data.isLinear;
  const isArtFlipped = node.m_isArtFlipped;
  // Include fields that affect visuals so property-editor edits invalidate naturally
  // without clearEventResourceCache() on the entire table.
  // Boss vs nonfinalboss is decided solely by m_levelNodeType (already in the key).
  const cacheKey = [
    node.m_eventId,
    node.m_eventType ?? '',
    node.m_dataString ?? '',
    node.m_cost ?? '',
    node.m_displayText ?? '',
    node.m_levelNodeType ?? '',
    worldName,
    resolution,
    status,
    isArtFlipped ? 't' : 'f',
    isLinear ? 't' : 'f',
  ].join('_');

  let cached = eventResourceCache.get(cacheKey);
  if (!cached) {
    const ctx: EventResourceCtx = {
      node,
      worldName,
      resolution,
      status,
      worldId: State.data.mapConfig?.objdata?.m_worldId || 1,
      isArtFlipped,
    };
    const resolver = EVENT_RESOURCE_RESOLVERS[eventType];
    if (!resolver) return Promise.resolve([]);
    cached = resolver(ctx);
    eventResourceCache.set(cacheKey, cached);
  }
  return cached;
}

export { stringToMapEventType, getAnimationProbabilityBucket } from './shared';
export type { EventResourceCtx } from './shared';