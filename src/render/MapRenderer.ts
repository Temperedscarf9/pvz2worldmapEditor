/**
 * Orchestrates a full (or incremental "eventOnly") render pass: walks the current world's
 * m_mapPieces + m_eventList, resolves each into DOM via PieceLoader/EventLoader/PathRenderer,
 * and mounts everything into the five covering-layer container grids (see ./layers.ts).
 */
import { PamCanvasPlayer } from '../pam/canvas-player';
import { findAnimInGlobal, findFileInGlobal, getObjectUrlCached, compileAnimAssets, findPieceAnim } from '../core/resources';
import {
  MapConfigObject,
  MapEventNode,
  PieceInfo,
  EventPieceInfo,
  WorldMapEventStatus,
  EventResourceDef,
} from '../domain/types';
import { State, pieceRuntimeMap, eventNodeRuntimeMap, imageDimensionsCache } from '../core/state';
import { CONFIG } from '../utils/constants';
import {
  fetchWorldMapListEntryPoint,
  fetchWorldMapListLastLevel,
  customEventStatusMap,
  customCMap,
  lastLoadedWorld,
  cachedSelectedWorldLastLevel,
  clearMaxImageIdCache,
  getWorldAnimationBoundary,
  setLastLoadedWorld,
  setCachedSelectedWorldLastLevel,
  setIsLastLevelNaturallyClearedGlobal,
  getParsedWorldMapList,
} from '../core/worldMeta';
import { resolveEventResources } from '../events/resolveEventResources';
import { loadPiece } from './PieceLoader';
import {
  loadEventPiecesForNode,
  loadResourcesToElement,
  attachStarsToElement,
  warmEventResources,
} from './EventLoader';
import {
  PathPieceInfo,
  activePathPieces,
  setActivePathPieces,
  detachActivePathPieces,
  compileGridTiles,
  preLoadPathPiece,
  findPathTextureFile,
  loadSingleImage,
} from './PathRenderer';
import { PARALLAX_LAYERS, DRAW_LAYERS, LAYER_Z, getGroupKey } from './layers';
import { DOM } from '../app/dom';

export function getNextZIndexInContainer(container: HTMLElement): number {
  let max = 0;
  for (let i = 0; i < container.children.length; i++) {
    const z = parseInt((container.children[i] as HTMLElement).style.zIndex || '0', 10);
    if (!isNaN(z) && z > max) max = z;
  }
  return max + 1;
}

// ---- Sparse layer-container construction ----
// renderMap() below only builds a parallax-root / draw-layer container for combinations
// actually used by at least one mapPiece/event/doodad in the currently loaded world, instead
// of unconditionally building all 15 PARALLAX_LAYERS x 47 DRAW_LAYERS x 2 (mapPieces + event)
// combinations (~1500 containers) on every single full render regardless of whether anything
// occupies them. That fixed grid was a major, entirely avoidable contributor to the multi-
// second gap between "loading overlay hidden" and "map actually responds to clicks": inserting
// ~1500 freshly-built elements into the live DOM in one synchronous burst forces the browser
// into a large layout/style/paint pass that runs after our JS has already finished and hidden
// the overlay, well after the code has told the user it explicitly waited for.
//
// The functions below compute the exact z-index any given (parallaxLayer, drawLayer) pair
// would have received under the old eager scheme - a pure function of its position in the
// fixed PARALLAX_LAYERS/DRAW_LAYERS lists, not of iteration/insertion order - so a container
// built later on demand (e.g. the Add tool placing something at a combination the loaded data
// never used) stacks identically to one built eagerly at render time.
const SORTED_PARALLAX_LAYERS = [...PARALLAX_LAYERS].sort((a, b) => b - a);

function computeParallaxZIndex(pLayer: number): number {
  const idx = SORTED_PARALLAX_LAYERS.indexOf(pLayer);
  return ((idx === -1 ? SORTED_PARALLAX_LAYERS.length : idx) + 1) * 10000;
}

function computeDrawLayerZIndex(dLayer: number): number {
  const idx = DRAW_LAYERS.indexOf(dLayer);
  return ((idx === -1 ? DRAW_LAYERS.length : idx) + 1) * 200;
}

/** Clamps to the same "unrecognized value falls back to 0" rule getGroupKey() applies, so a
 * container built here always lands under the same key a lookup for the same raw node values
 * would compute. */
function clampLayerPair(parallaxLayer: number, drawLayer: number): { pl: number; dl: number } {
  return {
    pl: PARALLAX_LAYERS.includes(parallaxLayer) ? parallaxLayer : 0,
    dl: DRAW_LAYERS.includes(drawLayer) ? drawLayer : 0,
  };
}

/** Finds (or lazily builds) the parallax-root <div> for pLayer directly under #map-container,
 * including its mapPieces/zomboss/path/event sub-structure - mirrors exactly what renderMap's
 * main loop builds eagerly for parallax layers it already knows are in use. */
function ensureParallaxRoot(pLayer: number): { mapPContainer: HTMLElement; eventPContainer: HTMLElement } {
  const existingMap = State.data.parallaxContainers.get(pLayer);
  const existingEvent = State.data.eventParallaxContainers.get(pLayer);
  if (existingMap && existingEvent) {
    return { mapPContainer: existingMap, eventPContainer: existingEvent };
  }

  const pRoot = document.createElement('div');
  pRoot.className = 'parallax-root-container';
  pRoot.style.position = 'absolute';
  pRoot.style.top = '0';
  pRoot.style.left = '0';
  pRoot.style.width = '100%';
  pRoot.style.height = '100%';
  pRoot.style.pointerEvents = 'none';
  pRoot.style.zIndex = String(computeParallaxZIndex(pLayer));

  const mapPiecesContainer = document.createElement('div');
  mapPiecesContainer.className = 'covering-layer-root map-pieces-layer';
  mapPiecesContainer.style.zIndex = String(LAYER_Z.mapPieces);
  pRoot.appendChild(mapPiecesContainer);

  const mapPContainer = document.createElement('div');
  mapPContainer.className = 'parallax-layer-container';
  mapPContainer.style.zIndex = '1';
  mapPiecesContainer.appendChild(mapPContainer);
  State.data.parallaxContainers.set(pLayer, mapPContainer);

  if (pLayer === 0 && !State.data.zombossContainer) {
    const zombossContainer = document.createElement('div');
    zombossContainer.className = 'covering-layer-root zomboss-layer';
    zombossContainer.style.zIndex = String(LAYER_Z.zomboss);
    pRoot.appendChild(zombossContainer);
    State.data.zombossContainer = zombossContainer;
  }
  if (pLayer === 0 && !State.data.pathContainer) {
    const pathContainer = document.createElement('div');
    pathContainer.className = 'covering-layer-root path-layer';
    pathContainer.style.zIndex = String(LAYER_Z.path);
    pRoot.appendChild(pathContainer);
    State.data.pathContainer = pathContainer;
  }

  const eventCovering = document.createElement('div');
  eventCovering.className = 'covering-layer-root events-layer';
  eventCovering.style.zIndex = String(LAYER_Z.event);
  pRoot.appendChild(eventCovering);
  if (pLayer === 0) State.data.eventContainer = eventCovering;

  const eventPContainer = document.createElement('div');
  eventPContainer.className = 'parallax-layer-container';
  eventPContainer.style.zIndex = '1';
  eventCovering.appendChild(eventPContainer);
  State.data.eventParallaxContainers.set(pLayer, eventPContainer);

  DOM.mapContainer.appendChild(pRoot);
  return { mapPContainer, eventPContainer };
}

/** Finds (or lazily builds) the mapPieces draw-layer container for (parallaxLayer, drawLayer).
 * Replaces a raw `State.data.drawLayerContainers.get(key)` lookup, which could return
 * undefined for any combination the sparse render loop didn't need to pre-build. */
export function getOrCreatePieceLayerContainer(parallaxLayer: number, drawLayer: number): HTMLElement {
  const { pl, dl } = clampLayerPair(parallaxLayer, drawLayer);
  const key = getGroupKey(pl, dl);
  const existing = State.data.drawLayerContainers.get(key);
  if (existing) return existing;

  const { mapPContainer } = ensureParallaxRoot(pl);
  const dContainer = document.createElement('div');
  dContainer.className = 'draw-layer-container';
  dContainer.style.zIndex = String(computeDrawLayerZIndex(dl));
  mapPContainer.appendChild(dContainer);
  State.data.drawLayerContainers.set(key, dContainer);
  return dContainer;
}

/** Event-layer equivalent of getOrCreatePieceLayerContainer(). */
export function getOrCreateEventLayerContainer(parallaxLayer: number, drawLayer: number): HTMLElement {
  const { pl, dl } = clampLayerPair(parallaxLayer, drawLayer);
  const key = getGroupKey(pl, dl);
  const existing = State.data.eventDrawLayerContainers.get(key);
  if (existing) return existing;

  const { eventPContainer } = ensureParallaxRoot(pl);
  const dContainer = document.createElement('div');
  dContainer.className = 'draw-layer-container';
  dContainer.style.zIndex = String(computeDrawLayerZIndex(dl));
  eventPContainer.appendChild(dContainer);
  State.data.eventDrawLayerContainers.set(key, dContainer);
  return dContainer;
}

export function clearPlayers(): void {
  State.players.forEach((p) => p.destroy());
  State.players = [];
  setActivePathPieces([]);
}

let activeRenderTaskId = 0;

export function cancelActiveRender(): void {
  activeRenderTaskId++;
}

/** Loads a File, resolving once it has decoded - used by preloadWorldResources for plain (non-anim) images. */
const PATH_TILE_FILENAMES = [
  'empty_ur_dl.png',
  'empty_ul_dr.png',
  'empty_ul_ur_dr.png',
  'empty_ul_ur_dl.png',
  'empty_ur_dl_dr.png',
  'empty_ul_dl_dr.png',
  'locked.png',
  'grass_light.png',
  'grass_dark.png',
];

/**
 * Warms path-connector assets for `worldName` at whatever resolution
 * State.data.textureResolution currently holds - star icons, the non-linear grid-tile PNG set,
 * and (linear mode only) the beam-path animation folder. Split out from preloadWorldResources
 * (which additionally re-touches this world's pieces/events, redundant work once Start preload
 * has already covered every world) so Start-time preload can warm every world's path assets
 * without paying that redundant cost N times.
 */
export async function preloadWorldPathAssets(worldName: string): Promise<void> {
  const isChina = State.data.isChinaVersion;
  const resolution = State.data.textureResolution;
  // China: images/{res}/UICommon/worldmap/common/star(_empty).png - dynamic resolution per the
  // given spec, unlike international's (pre-existing, left as-is) hardcoded 1536 tier.
  const starFile = isChina
      ? findFileInGlobal(`images/${resolution}/UICommon/worldmap/common/star.png`)
      : findFileInGlobal('images/1536/initial/worldmap/common/star.png');
  const starEmptyFile = isChina
      ? findFileInGlobal(`images/${resolution}/UICommon/worldmap/common/star_empty.png`)
      : findFileInGlobal('images/1536/initial/worldmap/common/star_empty.png');

  const tasks: Promise<unknown>[] = [starFile, starEmptyFile].map((f) =>
      f ? loadSingleImage(f) : Promise.resolve(null)
  );

  if (State.data.isLinear) {
    // China: images/{res}/UICommon/worldmap/map_path/ vs intl images/{res}/initial/worldmap/map_path/
    const pathAnimData = findAnimInGlobal(
        `images/${resolution}/${isChina ? 'UICommon' : 'initial'}/worldmap/map_path/`
    );
    if (pathAnimData) tasks.push(compileAnimAssets(pathAnimData));
  } else {
    tasks.push(
        ...PATH_TILE_FILENAMES.map((fname) => {
          const file = findPathTextureFile(worldName, fname);
          return file ? loadSingleImage(file) : Promise.resolve(null);
        })
    );
  }

  await Promise.all(tasks);
}

export async function preloadWorldResources(worldName: string, config: MapConfigObject, resolution: number): Promise<void> {
  await getParsedWorldMapList();

  const worldDataValue = config.objdata;
  const maxImageId = getWorldAnimationBoundary();
  const sortedPieces = worldDataValue.m_mapPieces || [];

  const piecePromises = sortedPieces.map(async (piece) => {
    const assets = State.data.worlds[worldName];
    if (!assets) return;
    const imageId = piece.m_imageID ?? 0;
    const isAnimation = imageId > maxImageId;

    if (!isAnimation) {
      let minI = 1;
      for (const filename of Object.keys(assets.images)) {
        const m = filename.match(/^island(\d+)\.png$/i);
        if (m) {
          const num = parseInt(m[1], 10);
          if (num < minI) minI = num;
        }
      }
      const offset = minI === 0 ? 0 : 1;
      const fileName = `${CONFIG.filePrefix}${imageId + offset}${CONFIG.fileExt}`;
      const file = assets.images[fileName];
      if (file && !imageDimensionsCache.has(file)) {
        const url = getObjectUrlCached(file);
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            imageDimensionsCache.set(file, { width: img.width, height: img.height });
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        });
      }
    } else {
      const animIndex = imageId - maxImageId;
      const anim = findPieceAnim(worldName, animIndex);
      if (anim && anim.json && anim.files.length) {
        await compileAnimAssets(anim);
      }
    }
  });

  const eventList = State.data.isMapOnly
      ? (worldDataValue.m_eventList || []).filter((n) => n.m_eventType === 'doodad')
      : (worldDataValue.m_eventList || []);
  const eventPromises = eventList.map(async (node) => {
    const resources = await resolveEventResources(node, worldName);
    if (!resources) return;
    await warmEventResources(resources);
  });

  await Promise.all([
    Promise.all(piecePromises),
    Promise.all(eventPromises),
    preloadWorldPathAssets(worldName),
  ]);
}

export async function renderMap(
    mapContainer: HTMLDivElement,
    emptyBorder: HTMLDivElement,
    resetCameraCallback: () => void,
    options: { eventOnly?: boolean; resetCamera?: boolean } = {}
): Promise<void> {
  if (!State.data.mapConfig || !State.data.selectedWorld) return;

  const myTaskId = ++activeRenderTaskId;
  const isInterrupted = () => myTaskId !== activeRenderTaskId;
  const resolution = State.data.textureResolution;
  const isLinear = State.data.isLinear;

  if (!options.eventOnly) {
    clearMaxImageIdCache();
  }
  const maxImageId = getWorldAnimationBoundary();
  const isEventOnly = options.eventOnly === true && State.data.eventContainer;

  const renderTarget = isEventOnly ? mapContainer : document.createElement('div');

  if (isEventOnly) {
    // In-place updating is handled later dynamically
  } else {
    clearPlayers();
    emptyBorder.style.display = 'none';
    State.data.pieces = [];
    State.data.eventPieces = [];
    State.data.parallaxContainers.clear();
    State.data.drawLayerContainers.clear();
    State.data.eventParallaxContainers.clear();
    State.data.eventDrawLayerContainers.clear();
    State.data.zombossContainer = null;
    State.data.pathContainer = null;
    State.data.eventContainer = null;
    pieceRuntimeMap.clear();
  }

  const worldDataValue = State.data.mapConfig.objdata;
  const worldId: number = worldDataValue.m_worldId || 1;

  if (!isEventOnly && worldDataValue.m_boundingRect) {
    State.data.boxLeft = (worldDataValue.m_boundingRect.mX * State.data.textureResolution) / 600;
  }

  let eventList = worldDataValue.m_eventList || [];

  if (lastLoadedWorld !== State.data.selectedWorld) {
    customEventStatusMap.clear();
    customCMap.clear();
    setLastLoadedWorld(State.data.selectedWorld);
    setCachedSelectedWorldLastLevel(await fetchWorldMapListLastLevel(State.data.selectedWorld || ''));
  }

  // Populate defaults into customEventStatusMap if not present
  for (const evt of eventList) {
    if (!customEventStatusMap.has(evt.m_eventId)) {
      customEventStatusMap.set(evt.m_eventId, WorldMapEventStatus.locked);
    }
  }

  // Dynamically resolve entry point node using EntryPoint in worldmaplist.json
  const entryPointName = await fetchWorldMapListEntryPoint(State.data.selectedWorld || '');
  let foundEntryPoint = false;

  if (entryPointName) {
    for (const evt of eventList) {
      if (evt.m_name === entryPointName && customEventStatusMap.get(evt.m_eventId) === WorldMapEventStatus.locked) {
        customEventStatusMap.set(evt.m_eventId, WorldMapEventStatus.unlocked);
        foundEntryPoint = true;
      }
    }
  }

  if (!foundEntryPoint) {
    // Fallback to defaults if EntryPoint isn't available or matching
    if (customEventStatusMap.get(1) === WorldMapEventStatus.locked) {
      customEventStatusMap.set(1, WorldMapEventStatus.unlocked);
    }
    for (const evt of eventList) {
      if (evt.m_name === 'tutorial_level_intro1' && customEventStatusMap.get(evt.m_eventId) === WorldMapEventStatus.locked) {
        customEventStatusMap.set(evt.m_eventId, WorldMapEventStatus.unlocked);
      }
    }
  }

  const isLastLevelNaturallyCleared = (() => {
    if (State.data.unlockAll) return true;
    if (!cachedSelectedWorldLastLevel) return false;
    for (const evt of eventList) {
      if (evt.m_name === cachedSelectedWorldLastLevel) {
        return customEventStatusMap.get(evt.m_eventId) === WorldMapEventStatus.cleared;
      }
    }
    return false;
  })();

  setIsLastLevelNaturallyClearedGlobal(isLastLevelNaturallyCleared);

  const getLevelStarLimitAndCount = (node: MapEventNode) => {
    const isChallenge = node.m_isChallengeType === true;

    if (isChallenge) {
      const max_stars = 1;
      const earned_stars = State.data.unlockAll ? 1 : (customCMap.get(node.m_eventId) ?? 0);
      return { max_stars, earned_stars };
    } else {
      if (isLastLevelNaturallyCleared || State.data.unlockAll) {
        const max_stars = 3;
        const earned_stars = State.data.unlockAll ? 3 : (customCMap.get(node.m_eventId) ?? 0);
        return { max_stars, earned_stars };
      } else {
        return { max_stars: 0, earned_stars: 0 };
      }
    }
  };

  const getEventStatus = (eventId: number): WorldMapEventStatus => {
    if (State.data.unlockAll) {
      return WorldMapEventStatus.cleared;
    }
    return customEventStatusMap.get(eventId) ?? WorldMapEventStatus.locked;
  };

  for (const evt of eventList) {
    const status = getEventStatus(evt.m_eventId);
    const { earned_stars } = getLevelStarLimitAndCount(evt);
    const C = Math.pow(2, earned_stars) - 1;

    eventNodeRuntimeMap.set(evt, {
      wmed: {
        W: worldId,
        E: evt.m_eventId,
        S: status,
        C: C,
      },
    });
  }

  if (isEventOnly) {
    if (!isLinear) {
      const worldName = State.data.selectedWorld || '';
      // Remove old tile elements from parent to avoid duplication
      detachActivePathPieces();

      const newTiles = await compileGridTiles(eventList, worldName, resolution, isInterrupted);
      if (isInterrupted()) return;
      setActivePathPieces(newTiles);
    }
    // Linear mode: no rebuild here. eventOnly only ever runs from a status/unlockAll toggle,
    // which never changes node positions or parent/child links - so every beam-path segment's
    // geometry is already correct as-is. The label-update pass below (search getCurrentLabel)
    // already re-plays 'beam_path_open'/'beam_path_on' on each existing player in place when a
    // node's status actually changed it - tearing down and recreating every segment's DOM +
    // PamCanvasPlayer here first (the old behavior) was pure unconditional waste on every single
    // toggle, and on a ~100+ node linear world was the dominant cost behind the multi-second lag.

    const existingPieceMap = new Map<string, EventPieceInfo>();
    State.data.eventPieces.forEach((p) => {
      const suffix = p.isZombossStage ? '_stage' : '_top';
      existingPieceMap.set(p.node.m_eventId + suffix, p);
    });

    // Resolve every node's target resources concurrently first (resolveEventResources is a
    // pure, self-cached lookup - see events/resolveEventResources.ts - so nodes don't interfere
    // with each other). The loop below then only does synchronous compatibility-diff/DOM work,
    // which must stay in list order for correct z-index/stacking, but no longer serializes on
    // network/decode-bound resolution one node at a time.
    const resolvedResourcesByNode = new Map<MapEventNode, EventResourceDef[]>();
    await Promise.all(
        eventList.map(async (node) => {
          const resources = await resolveEventResources(node, State.data.selectedWorld || '');
          resolvedResourcesByNode.set(node, resources);
        })
    );
    if (isInterrupted()) return;

    // Per-node work (compatibility diff + player update / in-place rebuild / fresh mount) has
    // no cross-node DOM-ordering dependency EXCEPT for brand-new pieces (no existingPiece yet
    // this render), whose first-time container append + z-index assignment must happen in
    // original list order to match what a full render would produce. So every node's async
    // work runs concurrently; "needs first-time append" results are collected separately and
    // appended (only those, still in original order) in one sequential pass afterward. This
    // preserves the exact ordering guarantee while no longer serializing the "just update this
    // node in place" case that dominates something like an unlockAll toggle touching every node
    // in the world at once.
    type PendingAppend = { element: HTMLDivElement; container: HTMLElement };
    const activeEventsList: EventPieceInfo[] = [];

    const perNodeResults = await Promise.all(
        eventList.map(async (node): Promise<{ active: EventPieceInfo[]; pendingAppends: PendingAppend[] }> => {
          if (isInterrupted()) return { active: [], pendingAppends: [] };
          const targetResources = resolvedResourcesByNode.get(node) || [];

          const isBossNode = node.m_eventType === 'level' && node.m_levelNodeType === 'boss';
          const isDanger = node.m_dataString?.endsWith('dangerroom');
          const active: EventPieceInfo[] = [];
          const pendingAppends: PendingAppend[] = [];

          async function handleOne(
              resources: EventResourceDef[],
              existingPiece: EventPieceInfo | undefined,
              isStageConfig: boolean,
              allowStars: boolean
          ): Promise<void> {
            if (resources.length === 0 && isBossNode) return; // boss stage/top may legitimately be empty

            if (existingPiece) {
              const prevResources = existingPiece.resources || [];
              let isCompatible = prevResources.length === resources.length && prevResources.length > 0;

              if (isCompatible) {
                for (let i = 0; i < resources.length; i++) {
                  const oldR = prevResources[i];
                  const newR = resources[i];
                  if (oldR.type !== newR.type) { isCompatible = false; break; }
                  if (oldR.type === 'animation') {
                    if (oldR.animData?.path !== newR.animData?.path) { isCompatible = false; break; }
                  } else if (oldR.type === 'image') {
                    if (oldR.file !== newR.file) { isCompatible = false; break; }
                  } else if (oldR.type === 'composited-image') {
                    if (oldR.url !== newR.url) { isCompatible = false; break; }
                  }
                }
              }

              if (isCompatible) {
                let playerIdx = 0;
                for (let i = 0; i < resources.length; i++) {
                  const newR = resources[i];
                  if (newR.type === 'animation' && existingPiece.players) {
                    const player = existingPiece.players[playerIdx++];
                    if (player) {
                      const opts: any = newR.options || {};
                      if (opts.probabilityBucket) {
                        player.setLabelProbabilityBucket(opts.probabilityBucket, opts.probabilitySide);
                      } else {
                        player.setLabelProbabilityBucket(null);
                        player.playLabel(opts.label || 'idle');
                      }
                    }
                  }
                }
                existingPiece.resources = resources;

                if (allowStars) {
                  const oldStars = existingPiece.element.querySelectorAll('.star-icon-piece');
                  oldStars.forEach(s => s.remove());
                  const targetEl = existingPiece.element.querySelector('.event-visual-wrapper') || existingPiece.element;
                  await attachStarsToElement(targetEl as HTMLDivElement, node);
                }
                active.push(existingPiece);
              } else {
                if (existingPiece.players) {
                  existingPiece.players.forEach((p) => {
                    p.destroy();
                    const glIdx = State.players.indexOf(p);
                    if (glIdx !== -1) State.players.splice(glIdx, 1);
                  });
                }
                existingPiece.element.innerHTML = '';
                existingPiece.players = [];

                const visualWrapper = document.createElement('div');
                visualWrapper.className = 'event-visual-wrapper';
                visualWrapper.style.cssText = `
                  position: absolute;
                  left: 50px;
                  top: 50px;
                  width: 0px;
                  height: 0px;
                `;
                existingPiece.element.appendChild(visualWrapper);

                const players: PamCanvasPlayer[] = [];
                const success = await loadResourcesToElement(resources, visualWrapper, node, players, isInterrupted);
                if (!success) return;

                existingPiece.players = players;
                existingPiece.resources = resources;

                if (allowStars) {
                  await attachStarsToElement(visualWrapper, node);
                }
                active.push(existingPiece);
              }
            } else {
              const newPieces = await loadEventPiecesForNode(node);
              if (isInterrupted()) {
                newPieces.forEach(p => p?.players?.forEach(pl => pl.destroy()));
                return;
              }
              const match = isBossNode ? newPieces.find(p => p.isZombossStage === isStageConfig) : newPieces[0];
              if (match) {
                const targetContainer = isBossNode
                    ? (isStageConfig ? State.data.zombossContainer : State.data.eventContainer)
                    : getOrCreateEventLayerContainer(node.m_parallaxLayer || 0, node.m_drawLayer || 0);
                if (targetContainer) {
                  pendingAppends.push({ element: match.element, container: targetContainer });
                  active.push(match);
                }
              }
            }
          }

          if (isBossNode) {
            const stageRes = targetResources.filter(r => r.type === 'animation' && r.animData?.path.includes('zomboss_node_') && !r.animData.path.includes('hologram'));
            const topRes = targetResources.filter(r => !(r.type === 'animation' && r.animData?.path.includes('zomboss_node_') && !r.animData.path.includes('hologram')));
            await handleOne(stageRes, existingPieceMap.get(node.m_eventId + '_stage'), true, false);
            await handleOne(topRes, existingPieceMap.get(node.m_eventId + '_top'), false, State.data.isLinear === false && !isDanger);
          } else {
            const isLevelNode = node.m_eventType === 'level';
            await handleOne(
                targetResources,
                existingPieceMap.get(node.m_eventId + '_top'),
                false,
                isLevelNode && State.data.isLinear === false && !isDanger
            );
          }

          return { active, pendingAppends };
        })
    );

    if (isInterrupted()) return;

    // Sequential pass, in original list order: only brand-new pieces land here (see comment
    // above), so this is normally a tiny or empty list even for a world-wide status toggle.
    for (const { pendingAppends } of perNodeResults) {
      for (const { element, container } of pendingAppends) {
        element.style.zIndex = String(getNextZIndexInContainer(container));
        container.appendChild(element);
      }
    }
    for (const { active } of perNodeResults) {
      activeEventsList.push(...active);
    }

    const activeEventIds = new Set(activeEventsList.map((p) => p.node.m_eventId));
    State.data.eventPieces.forEach((p) => {
      if (!activeEventIds.has(p.node.m_eventId)) {
        p.element?.parentNode?.removeChild(p.element);
        p.players?.forEach((pl) => {
          pl.destroy();
          const glIdx = State.players.indexOf(pl);
          if (glIdx !== -1) {
            State.players.splice(glIdx, 1);
          }
        });
      }
    });

    const layerA_isEventOnly = activeEventsList
        .filter(p => p.isZombossStage === true)
        .sort((a, b) =>
            (a.node.m_position?.y ?? 0) - (b.node.m_position?.y ?? 0) ||
            (a.node.m_position?.x ?? 0) - (b.node.m_position?.x ?? 0)
        );
    const layerD_isEventOnly = activeEventsList.filter(p => p.isZombossStage !== true);

    // Zomboss Stage Layer, Map Path Layer, and Event Layer are three independent containers
    // (each its own stacking context via LAYER_Z) - each gets its own small sequential z-index,
    // entirely independent of the other two and of Map Pieces/Doodad layers.
    if (State.data.zombossContainer) {
      let z = 1;
      layerA_isEventOnly.forEach((p) => {
        p.element.style.zIndex = String(z++);
        State.data.zombossContainer!.appendChild(p.element);
      });
    }
    if (State.data.pathContainer) {
      let z = 1;
      activePathPieces.forEach((path) => {
        path.element.style.zIndex = String(z++);
        State.data.pathContainer!.appendChild(path.element);
      });
    }
    const eventByContainer = new Map<HTMLElement, typeof layerD_isEventOnly>();
    for (const p of layerD_isEventOnly) {
      const container = getOrCreateEventLayerContainer(p.node.m_parallaxLayer || 0, p.node.m_drawLayer || 0);
      if (!eventByContainer.has(container)) eventByContainer.set(container, []);
      eventByContainer.get(container)!.push(p);
    }
    eventByContainer.forEach((group, container) => {
      group.sort(
          (a, b) =>
              (a.node.m_position?.y ?? 0) - (b.node.m_position?.y ?? 0) ||
              (a.node.m_position?.x ?? 0) - (b.node.m_position?.x ?? 0)
      );
      let z = 1000;
      group.forEach(p => {
        p.element.style.zIndex = String(z++);
        container.appendChild(p.element);
      });
    });

    State.data.eventPieces = [...layerA_isEventOnly, ...layerD_isEventOnly];

    for (const path of activePathPieces) {
      if (path.player) {
        const startNodeRuntime = eventNodeRuntimeMap.get(path.toNode!);
        const startNodeStatus = startNodeRuntime?.wmed?.S;
        const pathLabel = startNodeStatus === WorldMapEventStatus.cleared ? 'beam_path_open' : 'beam_path_on';
        if (path.player.getCurrentLabel() !== pathLabel) {
          path.player.playLabel(pathLabel, true, path.randomOffset);
        }
      }
    }

    // Map Only hides Zomboss Stage / Map Path / Event layers wholesale (Map Pieces and Doodad
    // stay visible) - toggling the three layer-root containers once is equivalent to, and far
    // cheaper than, touching every individual element.
    if (State.data.zombossContainer) State.data.zombossContainer.style.display = State.data.isMapOnly ? 'none' : '';
    if (State.data.pathContainer) State.data.pathContainer.style.display = State.data.isMapOnly ? 'none' : '';
    State.data.eventParallaxContainers.forEach((pContainer) => {
      const root = pContainer.parentElement as HTMLElement | null;
      if (root) root.style.display = State.data.isMapOnly ? 'none' : '';
    });
    if (State.data.eventContainer) State.data.eventContainer.style.display = State.data.isMapOnly ? 'none' : '';

    return;
  }

  const eventResults_nested = await Promise.all(eventList.map((n: MapEventNode) => loadEventPiecesForNode(n)));
  if (isInterrupted()) {
    eventResults_nested.flat().forEach(piece => {
      piece?.players?.forEach(p => {
        p.destroy();
        const glIdx = State.players.indexOf(p);
        if (glIdx !== -1) State.players.splice(glIdx, 1);
      });
    });
    return;
  }

  const eventResults = eventResults_nested.flat();

  const layerA = eventResults.filter(p => p.isZombossStage === true);
  const layerD = eventResults.filter(p => p.isZombossStage !== true); // 含 doodad

  const layerA_sorted = layerA.sort(
      (a, b) =>
          (a.node.m_position?.y ?? 0) - (b.node.m_position?.y ?? 0) ||
          (a.node.m_position?.x ?? 0) - (b.node.m_position?.x ?? 0)
  );

  const layerD_sorted = layerD.sort(
      (a, b) =>
          (a.node.m_position?.y ?? 0) - (b.node.m_position?.y ?? 0) ||
          (a.node.m_position?.x ?? 0) - (b.node.m_position?.x ?? 0)
  );

  // Final paint order is entirely determined by which (parallaxLayer, drawLayer) container an
  // element lands in, plus its position sort within that container (see buildGridLayer below) -
  // so sorting m_mapPieces by parallaxLayer/drawLayer here first has no effect on the outcome.
  const sortedPieces = [...worldDataValue.m_mapPieces!].sort(
      (a: MapEventNode, b: MapEventNode) =>
          (a.m_position?.y || 0) - (b.m_position?.y || 0) ||
          (a.m_position?.x || 0) - (b.m_position?.x || 0)
  );

  const results = await Promise.all(sortedPieces.map((p) => loadPiece(p, maxImageId)));
  if (isInterrupted()) {
    results.forEach(res => {
      if (res?.player) {
        res.player.destroy();
        const glIdx = State.players.indexOf(res.player);
        if (glIdx !== -1) State.players.splice(glIdx, 1);
      }
    });
    eventResults.forEach(piece => {
      piece?.players?.forEach(p => {
        p.destroy();
        const glIdx = State.players.indexOf(p);
        if (glIdx !== -1) State.players.splice(glIdx, 1);
      });
    });
    return;
  }
  const orderedPieces = results.filter((p): p is PieceInfo => p !== null);

  // Pre-load path animations or pseudo-3D grass/empty textures
  let resolvedPaths: PathPieceInfo[] = [];

  if (!isLinear) {
    const worldName = State.data.selectedWorld;
    if (worldName) {
      const tileResults = await compileGridTiles(eventList, worldName, resolution, isInterrupted);
      if (isInterrupted()) {
        results.forEach(res => {
          if (res?.player) {
            res.player.destroy();
            const glIdx = State.players.indexOf(res.player);
            if (glIdx !== -1) State.players.splice(glIdx, 1);
          }
        });
        eventResults.forEach(piece => {
          piece?.players?.forEach(p => {
            p.destroy();
            const glIdx = State.players.indexOf(p);
            if (glIdx !== -1) State.players.splice(glIdx, 1);
          });
        });
        return;
      }
      resolvedPaths = tileResults;
    }
  } else {
    const pathAnimDir = `images/${resolution}/${State.data.isChinaVersion ? 'UICommon' : 'initial'}/worldmap/map_path/`;
    const pathAnimData = findAnimInGlobal(pathAnimDir);

    if (pathAnimData) {
      const getNodeDepth = (node: MapEventNode): number => {
        let depth = 0;
        let current: MapEventNode | undefined = node;
        const visited = new Set<string>();
        while (current && current.m_parentEvent) {
          if (visited.has(current.m_name!)) break;
          visited.add(current.m_name!);
          const parentName: string = current.m_parentEvent;
          const parentNode = eventList.find((n: MapEventNode) => n.m_name === parentName);
          if (!parentNode) break;
          depth++;
          current = parentNode;
        }
        return depth;
      };

      const pathPromises: Promise<PathPieceInfo | null>[] = [];
      for (const nodeA of eventList) {
        if (nodeA.m_parentEvent) {
          const parentName = nodeA.m_parentEvent;
          const nodeB = eventList.find((n: MapEventNode) => n.m_name === parentName);
          if (nodeB && nodeA.m_position && nodeB.m_position) {
            const parentDepth = getNodeDepth(nodeB);
            const offsets = [66, 33, 0];
            const calculatedOffset = offsets[parentDepth % offsets.length];
            pathPromises.push(preLoadPathPiece(nodeA, nodeB, pathAnimData, calculatedOffset));
          }
        }
      }
      const pathResults = await Promise.all(pathPromises);
      if (isInterrupted()) {
        pathResults.forEach(p => p?.player?.destroy());
        results.forEach(res => {
          if (res?.player) {
            res.player.destroy();
            const glIdx = State.players.indexOf(res.player);
            if (glIdx !== -1) State.players.splice(glIdx, 1);
          }
        });
        eventResults.forEach(piece => {
          piece?.players?.forEach(p => {
            p.destroy();
            const glIdx = State.players.indexOf(p);
            if (glIdx !== -1) State.players.splice(glIdx, 1);
          });
        });
        return;
      }
      resolvedPaths = pathResults.filter((p): p is PathPieceInfo => p !== null);
    }
  }

  // Path segments don't have a single m_position of their own - use the midpoint of the two
  // nodes they connect as their representative position for sorting.
  resolvedPaths = resolvedPaths.sort((a, b) => {
    const ay = ((a.fromNode?.m_position?.y ?? 0) + (a.toNode?.m_position?.y ?? 0)) / 2;
    const by = ((b.fromNode?.m_position?.y ?? 0) + (b.toNode?.m_position?.y ?? 0)) / 2;
    if (ay !== by) return ay - by;
    const ax = ((a.fromNode?.m_position?.x ?? 0) + (a.toNode?.m_position?.x ?? 0)) / 2;
    const bx = ((b.fromNode?.m_position?.x ?? 0) + (b.toNode?.m_position?.x ?? 0)) / 2;
    return ax - bx;
  });

  // Which (parallaxLayer, drawLayer) combinations are actually occupied - mapPieces and events
  // are tracked separately since a given parallax layer can use different draw layers in each.
  // Zomboss pieces always mount into the pLayer===0 root regardless of their own
  // m_parallaxLayer (matching the unconditional `if (pLayer === 0)` zomboss-mount below), so
  // pLayer 0 is always included even for a world with nothing else placed there.
  const usedParallaxLayers = new Set<number>([0]);
  const usedMapPieceDrawLayers = new Map<number, Set<number>>();
  const usedEventDrawLayers = new Map<number, Set<number>>();

  for (const r of orderedPieces) {
    const { pl, dl } = clampLayerPair(r.piece.m_parallaxLayer || 0, r.piece.m_drawLayer || 0);
    usedParallaxLayers.add(pl);
    if (!usedMapPieceDrawLayers.has(pl)) usedMapPieceDrawLayers.set(pl, new Set());
    usedMapPieceDrawLayers.get(pl)!.add(dl);
  }
  for (const e of layerD) {
    const { pl, dl } = clampLayerPair(e.node.m_parallaxLayer || 0, e.node.m_drawLayer || 0);
    usedParallaxLayers.add(pl);
    if (!usedEventDrawLayers.has(pl)) usedEventDrawLayers.set(pl, new Set());
    usedEventDrawLayers.get(pl)!.add(dl);
  }

  const sortedParallaxLayers = SORTED_PARALLAX_LAYERS.filter((pl) => usedParallaxLayers.has(pl));

  for (const pLayer of sortedParallaxLayers) {
    const pRoot = document.createElement('div');
    pRoot.className = 'parallax-root-container';
    pRoot.style.position = 'absolute';
    pRoot.style.top = '0';
    pRoot.style.left = '0';
    pRoot.style.width = '100%';
    pRoot.style.height = '100%';
    pRoot.style.pointerEvents = 'none';
    pRoot.style.zIndex = String(computeParallaxZIndex(pLayer));
    renderTarget.appendChild(pRoot);

    // 1. Map Pieces Layer (for this pLayer) - only the draw layers actually used here
    const mapPiecesContainer = document.createElement('div');
    mapPiecesContainer.className = 'covering-layer-root map-pieces-layer';
    mapPiecesContainer.style.zIndex = String(LAYER_Z.mapPieces);
    pRoot.appendChild(mapPiecesContainer);

    const mapPContainer = document.createElement('div');
    mapPContainer.className = 'parallax-layer-container';
    mapPContainer.style.zIndex = '1';
    mapPiecesContainer.appendChild(mapPContainer);
    State.data.parallaxContainers.set(pLayer, mapPContainer);

    const piecesAtLayer = orderedPieces.filter(r => clampLayerPair(r.piece.m_parallaxLayer || 0, r.piece.m_drawLayer || 0).pl === pLayer);
    const piecesGroupedByDrawLayer = new Map<number, typeof piecesAtLayer>();
    piecesAtLayer.forEach(r => {
      const dl = clampLayerPair(r.piece.m_parallaxLayer || 0, r.piece.m_drawLayer || 0).dl;
      if (!piecesGroupedByDrawLayer.has(dl)) piecesGroupedByDrawLayer.set(dl, []);
      piecesGroupedByDrawLayer.get(dl)!.push(r);
    });

    for (const dLayer of DRAW_LAYERS) {
      const group = piecesGroupedByDrawLayer.get(dLayer);
      if (!group || group.length === 0) continue;

      const dContainer = document.createElement('div');
      dContainer.className = 'draw-layer-container';
      dContainer.style.zIndex = String(computeDrawLayerZIndex(dLayer));
      mapPContainer.appendChild(dContainer);
      State.data.drawLayerContainers.set(getGroupKey(pLayer, dLayer), dContainer);

      const sortedGroup = [...group].sort((a, b) => {
        const ay = a.piece.m_position?.y ?? 0;
        const by = b.piece.m_position?.y ?? 0;
        if (ay !== by) return ay - by;
        const ax = a.piece.m_position?.x ?? 0;
        const bx = b.piece.m_position?.x ?? 0;
        return ax - bx;
      });
      let localZ = 1000;
      sortedGroup.forEach(r => {
        r.element.style.zIndex = String(localZ++);
        dContainer.appendChild(r.element);
        State.data.pieces.push(r);
      });
    }

    // 2. Zomboss Stage Layer (only at pLayer === 0)
    if (pLayer === 0) {
      const zombossContainer = document.createElement('div');
      zombossContainer.className = 'covering-layer-root zomboss-layer';
      zombossContainer.style.zIndex = String(LAYER_Z.zomboss);
      pRoot.appendChild(zombossContainer);
      State.data.zombossContainer = zombossContainer;

      let z = 1;
      layerA_sorted.forEach((e) => {
        e.element.style.zIndex = String(z++);
        zombossContainer.appendChild(e.element);
        State.data.eventPieces.push(e);
      });
    }

    // 3. Map Path Layer (only at pLayer === 0)
    if (pLayer === 0) {
      const pathContainer = document.createElement('div');
      pathContainer.className = 'covering-layer-root path-layer';
      pathContainer.style.zIndex = String(LAYER_Z.path);
      pRoot.appendChild(pathContainer);
      State.data.pathContainer = pathContainer;

      let z = 1;
      resolvedPaths.forEach((path) => {
        path.element.style.zIndex = String(z++);
        pathContainer.appendChild(path.element);
        if (path.player) State.players.push(path.player);
        activePathPieces.push(path);
      });
    }

    // 4. Event Layer（doodad + 其它 non-zomboss）— 每个 pLayer，只建实际用到的 drawLayer
    // 排序：m_drawLayer 容器 → y → x
    const eventCovering = document.createElement('div');
    eventCovering.className = 'covering-layer-root events-layer';
    eventCovering.style.zIndex = String(LAYER_Z.event);
    pRoot.appendChild(eventCovering);
    if (pLayer === 0) State.data.eventContainer = eventCovering;

    const eventPContainer = document.createElement('div');
    eventPContainer.className = 'parallax-layer-container';
    eventPContainer.style.zIndex = '1';
    eventCovering.appendChild(eventPContainer);
    State.data.eventParallaxContainers.set(pLayer, eventPContainer);

    const eventsAtLayer = layerD.filter(e => clampLayerPair(e.node.m_parallaxLayer || 0, e.node.m_drawLayer || 0).pl === pLayer);
    const byDraw = new Map<number, typeof eventsAtLayer>();
    eventsAtLayer.forEach(e => {
      const dl = clampLayerPair(e.node.m_parallaxLayer || 0, e.node.m_drawLayer || 0).dl;
      if (!byDraw.has(dl)) byDraw.set(dl, []);
      byDraw.get(dl)!.push(e);
    });

    for (const dLayer of DRAW_LAYERS) {
      const group = byDraw.get(dLayer);
      if (!group || group.length === 0) continue;

      const dContainer = document.createElement('div');
      dContainer.className = 'draw-layer-container';
      dContainer.style.zIndex = String(computeDrawLayerZIndex(dLayer));
      eventPContainer.appendChild(dContainer);
      State.data.eventDrawLayerContainers.set(getGroupKey(pLayer, dLayer), dContainer);

      const sortedGroup = [...group].sort(
          (a, b) =>
              (a.node.m_position?.y ?? 0) - (b.node.m_position?.y ?? 0) ||
              (a.node.m_position?.x ?? 0) - (b.node.m_position?.x ?? 0)
      );
      let localZ = 1000;
      sortedGroup.forEach(e => {
        e.element.style.zIndex = String(localZ++);
        dContainer.appendChild(e.element);
        State.data.eventPieces.push(e);
      });
    }
  }

  if (!isEventOnly) {
    if (!isInterrupted()) {
      mapContainer.innerHTML = '';
      while (renderTarget.firstChild) {
        mapContainer.appendChild(renderTarget.firstChild);
      }
    }
  }

  // Map Only hides Zomboss Stage / Map Path / Event layers wholesale (Map Pieces and Doodad
  // stay visible) - toggling the three layer-root containers once is equivalent to, and far
  // cheaper than, touching every individual element.
  if (State.data.zombossContainer) State.data.zombossContainer.style.display = State.data.isMapOnly ? 'none' : '';
  if (State.data.pathContainer) State.data.pathContainer.style.display = State.data.isMapOnly ? 'none' : '';
  State.data.eventParallaxContainers.forEach((pContainer) => {
    const root = pContainer.parentElement as HTMLElement | null;
    if (root) root.style.display = State.data.isMapOnly ? 'none' : '';
  });
  if (State.data.eventContainer) State.data.eventContainer.style.display = State.data.isMapOnly ? 'none' : '';

  if (options.resetCamera) {
    resetCameraCallback();
  }
}