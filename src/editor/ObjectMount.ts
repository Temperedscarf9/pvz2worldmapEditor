import { degreeToRad } from '../utils/mathTool';
import { State, pieceRuntimeMap } from '../core/state';
import { getWorldAnimationBoundary } from '../core/worldMeta';
import { getNextZIndexInContainer, getOrCreatePieceLayerContainer, getOrCreateEventLayerContainer } from '../render/MapRenderer';
import { computeLocalTransform, loadPiece, preparePiece } from '../render/PieceLoader';
import { computeEventLocalTransform, loadEventPiecesForNode } from '../render/EventLoader';
import { updatePathElements } from '../render/PathRenderer';
import { getSelectedNode, isMapPieceRef } from './types';
import { EditorState } from './EditorState';
import { clearSelection, selectPiece } from './Selection';
import { updateToolbarState } from '../ui/toolbar';

/** Finds (or, since renderMap() only pre-builds containers for combinations actually used by
 * the loaded world, lazily creates) the layer container a piece/event belongs in. Always
 * returns a real container now - see getOrCreate{Piece,Event}LayerContainer in MapRenderer.ts. */
export function getPieceLayerContainer(node: any): HTMLElement {
  return getOrCreatePieceLayerContainer(node.m_parallaxLayer ?? 0, node.m_drawLayer ?? 0);
}

export function getEventLayerContainer(node: any): HTMLElement {
  return getOrCreateEventLayerContainer(node.m_parallaxLayer ?? 0, node.m_drawLayer ?? 0);
}

/** Destroys each PamCanvasPlayer and drops it from State.players; shared by the two destroy*Info helpers below. */
function destroyMountedPlayers(players: any[] | undefined): void {
  if (!players) return;
  players.forEach((pl: any) => {
    pl.destroy();
    const i = State.players.indexOf(pl);
    if (i !== -1) State.players.splice(i, 1);
  });
}

export function destroyPieceInfo(pInfo: any): void {
  destroyMountedPlayers(pInfo?.player ? [pInfo.player] : undefined);
  pInfo?.element?.parentNode?.removeChild(pInfo.element);
}

export function destroyEventPieceInfo(ep: any): void {
  destroyMountedPlayers(ep?.players);
  ep?.element?.parentNode?.removeChild(ep.element);
}

export function applyTransformOnly(node: any): void {
  const maxImageId = getWorldAnimationBoundary();
  const runtime = pieceRuntimeMap.get(node);

  if (runtime) {
    runtime.flipScale = node.m_isArtFlipped ? -1 : 1;
    runtime.scaleX = node.m_scaleX ?? 1;
    runtime.scaleY = node.m_scaleY ?? 1;

    if ((node.m_imageID ?? 0) > maxImageId) {
      const STEP = 2647 / 180;
      runtime.angle = degreeToRad(-(STEP * (node.m_rotationAngle ?? 0) % 360));
    } else {
      runtime.angle = degreeToRad(node.m_rotationAngle ?? 0);
    }
  }

  State.data.pieces.forEach(p => {
    if (p.piece === node) {
      const visualEl = p.element.querySelector('.map-piece-visual') as HTMLDivElement;
      const t = computeLocalTransform(node, maxImageId);
      if (visualEl) visualEl.style.transform = t;
      else p.element.style.transform = t;
    }
  });

  State.data.eventPieces.forEach(ep => {
    if (ep.node === node) {
      ep.element.style.transform = computeEventLocalTransform(node, 0, 0, 1);
      // 如果有内部 visual wrapper，也需要更新
    }
  });
}

/** 卸载某个 node 在画面上的全部 DOM / player，并从 State 列表移除 */
export function detachNodeFromRender(node: any): void {
  // map pieces
  const keepPieces: typeof State.data.pieces = [];
  State.data.pieces.forEach((p) => {
    if (p.piece === node) destroyPieceInfo(p);
    else keepPieces.push(p);
  });
  State.data.pieces = keepPieces;

  // event / doodad / zomboss（同一 node 可能有 stage + top 两份）
  const keepEvents: typeof State.data.eventPieces = [];
  State.data.eventPieces.forEach((ep) => {
    if (ep.node === node) destroyEventPieceInfo(ep);
    else keepEvents.push(ep);
  });
  State.data.eventPieces = keepEvents;

  EditorState.rotatingPieces = State.data.pieces.filter((pInfo) => pInfo.piece.m_rotationRate);
  pieceRuntimeMap.delete(node);
}

/** 重新加载并挂载一个 map piece（imageID / 图层变更等） */
export async function mountMapPiece(node: any): Promise<any | null> {
  const maxImageId = getWorldAnimationBoundary();
  preparePiece(node);
  const result = loadPiece(node, maxImageId);
  const pInfo = result ? await result : null;
  if (!pInfo) return null;

  const container = getPieceLayerContainer(node);
  if (!container) {
    console.warn('[mountMapPiece] missing layer container', node.m_parallaxLayer, node.m_drawLayer);
    return null;
  }
  pInfo.element.style.zIndex = String(getNextZIndexInContainer(container));
  container.appendChild(pInfo.element);
  State.data.pieces.push(pInfo);
  EditorState.rotatingPieces = State.data.pieces.filter((p) => p.piece.m_rotationRate);
  return pInfo;
}

/** 重新加载并挂载 event / doodad（可能返回多个 piece，如 boss stage+top） */
export async function mountEventNode(node: any): Promise<any[]> {
  const newPieces = await loadEventPiecesForNode(node);
  if (!newPieces || newPieces.length === 0) return [];

  for (const match of newPieces) {
    let targetContainer: HTMLElement | null = null;
    if (match.isZombossStage) {
      targetContainer = State.data.zombossContainer;
    } else {
      targetContainer = getEventLayerContainer(node);
    }
    if (!targetContainer) continue;

    match.element.style.zIndex = String(getNextZIndexInContainer(targetContainer));
    targetContainer.appendChild(match.element);
    State.data.eventPieces.push(match);
  }
  return newPieces;
}

/**
 * Remount a single event/doodad node (and lightly refresh path tiles).
 * Previously this called triggerMapRender({ eventOnly: true }) which rebuilt the entire
 * event layer + re-resolved every node's resources — multi-second freezes on every
 * Event Property Editor save. Single-node remount is enough for visual property edits.
 */
export async function mountOrRefreshEventNode(node: any): Promise<any> {
  const newPieces = await mountEventNode(node);
  // Path geometry may depend on this node (parent links / position); cheap vs full event re-render
  try {
    updatePathElements();
  } catch (e) {
    console.warn('[mountOrRefreshEventNode] updatePathElements failed', e);
  }
  // Prefer the non-zomboss-stage piece for selection (clickable top)
  const top = newPieces.find((p) => !p.isZombossStage);
  return top || newPieces[0] || null;
}

/**
 * 编辑后刷新「这一个」对象。
 * @param node
 * @param mode
 *   - 'transform'  只改 CSS transform（旋转/翻转/scale）
 *   - 'reload'     拆掉旧 DOM，按最新数据重建该对象
 *   - 'remove'     只从画面移除
 */
export async function refreshSingleObject(
    node: any,
    mode: 'transform' | 'reload' | 'remove' = 'reload'
): Promise<void> {
  if (!node) return;

  if (mode === 'remove') {
    detachNodeFromRender(node);
    clearSelection();
    return;
  }

  const isMapPiece = (State.data.mapConfig?.objdata?.m_mapPieces || []).includes(node)
      || State.data.pieces.some((p) => p.piece === node);

  if (mode === 'transform' && isMapPiece) {
    applyTransformOnly(node);
    return;
  }

  // reload：先卸再挂（只动这一只，不重渲整层）
  const wasSelected = EditorState.selectedPieceRef && getSelectedNode(EditorState.selectedPieceRef) === node;

  detachNodeFromRender(node);

  const reselect = isMapPiece ? await mountMapPiece(node) : await mountOrRefreshEventNode(node);

  if (wasSelected && reselect) selectPiece(reselect);
  else if (wasSelected) clearSelection();
  else updateToolbarState();
}

/** 新添加的对象：只 mount，不碰其它对象 */
export async function mountNewObject(node: any, kind: 'piece' | 'event' | 'doodad'): Promise<void> {
  const reselect = kind === 'piece' ? await mountMapPiece(node) : await mountOrRefreshEventNode(node);
  if (reselect) selectPiece(reselect);
}

/**
 * CurLayer ON（仅影响 mapPiece，不碰 doodad / path / event / zomboss；覆盖层显隐由 Map Only 负责）：
 *   - m_drawLayer > defaultDrawLayer → 视觉 15% 透明 + mismatch 灰 hitbox（不可点）
 *   - m_drawLayer === defaultDrawLayer → match（当前层）
 *   - m_drawLayer <  defaultDrawLayer → mismatch（灰、不可点）
 * CurLayer OFF：清除所有 mapPiece 层过滤类，全部正常显示。
 */
export function applyDrawLayerFilter(): void {
  const cur = EditorState.defaultDrawLayer;
  const filterOn = EditorState.isCurLayerActive;

  // ---------- mapPiece：仅 ON 时按 m_drawLayer 过滤 ----------
  State.data.pieces.forEach((p) => {
    const el = p.element;
    if (!el) return;
    el.classList.remove('layer-above-hidden', 'layer-match', 'layer-mismatch');
    if (!filterOn) return; // 关闭 = 全部显示
    const layer = p.piece?.m_drawLayer ?? 0;
    if (layer > cur) {
      // 更高层：半透明视觉 + 灰色 hitbox（与 mismatch 相同交互）
      el.classList.add('layer-above-hidden', 'layer-mismatch');
    } else if (layer === cur) {
      el.classList.add('layer-match');
    } else {
      el.classList.add('layer-mismatch');
    }
  });

  // doodad / event 不参与 CurLayer 层过滤，确保无残留类
  State.data.eventPieces.forEach((ep) => {
    ep.element?.classList.remove('layer-above-hidden', 'layer-match', 'layer-mismatch');
  });

  if (filterOn && EditorState.selectedPieceRef && isMapPieceRef(EditorState.selectedPieceRef)) {
    const node = getSelectedNode(EditorState.selectedPieceRef);
    if (node && (node.m_drawLayer ?? 0) !== cur) {
      clearSelection();
    }
  }
}

/** 仅切换 zomboss / path / event 三层的 display，不触发重渲染（避免重置动画时间线） */
export function applyMapOnlyVisibility(): void {
  const hide = !!State.data.isMapOnly;
  if (State.data.zombossContainer) State.data.zombossContainer.style.display = hide ? 'none' : '';
  if (State.data.pathContainer) State.data.pathContainer.style.display = hide ? 'none' : '';
  State.data.eventParallaxContainers.forEach((pContainer) => {
    const root = pContainer.parentElement as HTMLElement | null;
    if (root) root.style.display = hide ? 'none' : '';
  });
  if (State.data.eventContainer) State.data.eventContainer.style.display = hide ? 'none' : '';
}