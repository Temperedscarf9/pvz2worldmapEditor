import { State, pieceRuntimeMap } from '../core/state';
import { CoordinateSystem, resetCamera, updateContainerTransform, drawWorldBounds, ZoomHelper } from '../core/camera';
import { degreeToRad, Matrix, toGridCoords, fromGridCoords } from '../utils/mathTool';
import { getWorldAnimationBoundary, resetRendererRuntimeState } from '../core/worldMeta';
import {
  clearComposedPacketCache,
  loadPlantPacketMetadata,
  rebuildWorldAssets,
} from '../core/resources';
import { clearEventResourceCache } from '../events/resolveEventResources';
import { renderMap, preloadWorldResources } from '../render/MapRenderer';
import { updatePathElements } from '../render/PathRenderer';
import { computeLocalTransform } from '../render/PieceLoader';

import { DOM, BBox, showConfirmModal } from './dom';
import { showToast } from '../ui/toast';
import { showGlobalLoading, updateGlobalLoading, hideGlobalLoading, nextFrame, yieldToBrowser, runWithDeferredLoading } from '../ui/loading';
import { updateToolbarState, setDrawSubMode } from '../ui/toolbar';
import { populateWorldSelector } from '../ui/sidebar';

import { EditorState, EVENT_TYPE_CYCLE } from '../editor/EditorState';
import { setTriggerMapRender } from '../editor/renderTrigger';
import { getSelectedNode, isDoodadRef, isEventNodeRef, isEventPieceRef, isMapPieceRef } from '../editor/types';
import { clearSelection, selectPiece } from '../editor/Selection';
import {
  refreshSingleObject,
  mountNewObject,
  applyMapOnlyVisibility,
} from '../editor/ObjectMount';
import { deletePieceOrNode } from '../editor/commands/DeleteCommand';
import { addNewMapPiece, addNewDoodad, addNewEventNode, collectAvailableImageIds, cycleImageId } from '../editor/commands/AddCommand';
import { flipNode } from '../editor/commands/FlipCommand';
import { applyDragMove, finalizeDragPathUpdate } from '../editor/commands/MoveCommand';
import {
  openRotatePanel,
  closeRotatePanel,
  applyRotateDelta,
  bindRotatePanel,
  hasActiveRotateTarget,
} from '../editor/commands/RotateCommand';
import { openEventEditorModal } from '../editor/EventPropertyEditor';
import {
  clearAll,
  unloadResourcePack,
  handleSaveMap,
  handleResetMap,
  handleWorldSelect,
  handleImageUpload,
  autoSaveToLocalStorage,
  handleStartViewer,
  handleRebuildPlantAssets,
} from '../editor/MapIO';

export const EditorApp = (() => {
  function initBBox(): void {
    const c = BBox.canvas;
    if (!c) return;
    c.width  = DOM.viewport.clientWidth;
    c.height = DOM.viewport.clientHeight;
    BBox.ctx = c.getContext('2d');
    EditorState.cameraDirty = true;
  }

  function handleUpdateTransform(): void {
    const rect = DOM.viewport.getBoundingClientRect();
    updateContainerTransform(
        DOM.mapContainer,
        DOM.uiElements.zoomDisplay,
        DOM.uiElements.footerCoord,
        rect.width,
        rect.height
    );
    EditorState.cameraDirty = true;
  }

  function handleResetCamera(): void {
    const rect = DOM.viewport.getBoundingClientRect();
    resetCamera(EditorState.targetCamera, rect.width, rect.height, handleUpdateTransform);
  }

  async function triggerMapRender(options: { eventOnly?: boolean; resetCamera?: boolean } = {}): Promise<void> {
    try {
      if (!options.eventOnly) {
        EditorState.rotatingPieces = [];
      }
      await renderMap(DOM.mapContainer, DOM.emptyBorder, handleResetCamera, options);

      // Re-select active element if it's still present in the updated render lists
      if (EditorState.selectedPieceRef) {
        const node = getSelectedNode(EditorState.selectedPieceRef);
        if (node) {
          const matchPiece = State.data.pieces.find(p => p.piece.m_name === node.m_name || p.piece.m_eventId === node.m_eventId);
          const matchEvent = State.data.eventPieces.find(p => p.node.m_name === node.m_name || p.node.m_eventId === node.m_eventId);
          const reFound = matchPiece || matchEvent;
          if (reFound) {
            selectPiece(reFound);
          } else {
            clearSelection();
          }
        }
      } else {
        updateToolbarState();
      }
    } catch (err) {
      console.error('Error rendering map:', err);
    }
  }
  function drawIsometricGrid(): void {
    const canvas = document.getElementById('grid-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const check = document.getElementById('isometric-grid-checkbox') as HTMLInputElement | null;
    if (!check || !check.checked) return;

    // Set canvas dimensions to viewport size
    canvas.width = DOM.viewport.clientWidth;
    canvas.height = DOM.viewport.clientHeight;

    // Draw isometric grid lines based on camera transform
    const camera = EditorState.targetCamera; // target x, y, scale
    const zoom = camera.scale;

    ctx.save();
    // Center of viewport
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.translate(cx + camera.x, cy + camera.y);
    ctx.scale(zoom, zoom);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1 / zoom;

    // PvZ2 standard isometric grid angles (77.74px/62.35px matrix)
    const spacing = 150;
    const limit = 3000;

    for (let i = -limit; i <= limit; i += spacing) {
      // Draw lines running from top-left-ish to bottom-right-ish
      ctx.beginPath();
      ctx.moveTo(-limit, i - limit * 0.5);
      ctx.lineTo(limit, i + limit * 0.5);
      ctx.stroke();

      // Draw lines running from bottom-left-ish to top-right-ish
      ctx.beginPath();
      ctx.moveTo(-limit, i + limit * 0.5);
      ctx.lineTo(limit, i - limit * 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  const BASE_FRICTION = 0.92;
  const BASE_FRAME_MS = 1000 / 60;
  // Time budget for the player-tick loop below, in ms of a ~16.6ms (60fps) frame. Normal: leave
  // most of the frame for animation since nothing else needs priority. Tight: while UI that
  // wants input to feel responsive is open (EditorState.uiFocusDepth > 0, e.g. the Event
  // Property Editor), shrink the animation slice so more of each frame is free for the browser
  // to dispatch queued input/DOM work - animation keeps running, just in smaller per-frame
  // chunks, rotating through State.players across frames instead of doing all of them every
  // single frame.
  const FRAME_BUDGET_MS = 10;
  const FRAME_BUDGET_MS_TIGHT = 3;

  function tick(timestamp: number): void {
    const dt = timestamp - (State.interaction.lastFrameTime || timestamp);
    State.interaction.lastFrameTime = timestamp;
    const dtSeconds = dt / 1000;

    if (!State.interaction.isDragging) {
      const friction = Math.pow(BASE_FRICTION, dt / BASE_FRAME_MS);
      State.interaction.velocityX *= friction;
      State.interaction.velocityY *= friction;
      if (Math.abs(State.interaction.velocityX) > 0.05 || Math.abs(State.interaction.velocityY) > 0.05) {
        EditorState.targetCamera.x += State.interaction.velocityX;
        EditorState.targetCamera.y += State.interaction.velocityY;
      }
    }

    // Smooth camera glide easing interpolation
    const diffX = EditorState.targetCamera.x - State.camera.x;
    const diffY = EditorState.targetCamera.y - State.camera.y;
    const diffS = EditorState.targetCamera.scale - State.camera.scale;

    const EPSILON = 0.001;
    if (Math.abs(diffX) > EPSILON || Math.abs(diffY) > EPSILON || Math.abs(diffS) > EPSILON) {
      const lerpingSpeed = State.interaction.isDragging ? 1.0 : (1 - Math.pow(0.01, dtSeconds));
      State.camera.x += diffX * lerpingSpeed;
      State.camera.y += diffY * lerpingSpeed;
      State.camera.scale += diffS * lerpingSpeed;
      handleUpdateTransform();
    }

    if (EditorState.cameraDirty) {
      if (State.data.mapConfig) {
        const vpWorldLeft = CoordinateSystem.screenToWorld(0, 0).x;
        const dx = (vpWorldLeft - State.data.boxLeft);
        State.data.parallaxContainers.forEach((container, layer) => {
          container.style.transform = `translateX(${(layer / 10) * dx}px)`;
        });

        if (BBox.canvas && BBox.ctx) {
          const check = document.getElementById('bounding-rect-checkbox') as HTMLInputElement | null;
          if (!check || check.checked) {
            drawWorldBounds(BBox.canvas, BBox.ctx);
          } else {
            BBox.ctx.clearRect(0, 0, BBox.canvas.width, BBox.canvas.height);
          }
        }
      } else {
        if (BBox.canvas && BBox.ctx) {
          BBox.ctx.clearRect(0, 0, BBox.canvas.width, BBox.canvas.height);
        }
      }

      drawIsometricGrid();
      EditorState.cameraDirty = false;
    }

    // Dynamic rotation modifiers tick update
    if (EditorState.rotatingPieces.length === 0 && State.data.pieces.length > 0) {
      EditorState.rotatingPieces = State.data.pieces.filter((pInfo) => pInfo.piece.m_rotationRate);
    }
    for (const pInfo of EditorState.rotatingPieces) {
      if (pInfo.piece.m_rotationRate) {
        const runtime = pieceRuntimeMap.get(pInfo.piece);
        if (runtime) {
          runtime.angle = (runtime.angle || 0) + degreeToRad(pInfo.piece.m_rotationRate * dtSeconds);
          const maxImageId = getWorldAnimationBoundary();
          const visualEl = pInfo.element.querySelector('.map-piece-visual') as HTMLDivElement;
          if (visualEl) {
            visualEl.style.transform = computeLocalTransform(pInfo.piece, maxImageId);
          } else {
            pInfo.element.style.transform = computeLocalTransform(pInfo.piece, maxImageId);
          }
        }
      }
    }

    // Centralized update of all active PAM animations - time-budgeted (see FRAME_BUDGET_MS/
    // FRAME_BUDGET_MS_TIGHT above and EditorState.uiFocusDepth). A frame with more active
    // players than fit in the budget picks up where it left off next frame via
    // EditorState.playerTickCursor, instead of processing all of them unconditionally (which
    // would starve input handling for however long that takes) or skipping any of them
    // permanently (which would visibly stall their animation).
    const now = performance.now();
    const totalPlayers = State.players.length;
    if (totalPlayers > 0) {
      const budgetMs = EditorState.uiFocusDepth > 0 ? FRAME_BUDGET_MS_TIGHT : FRAME_BUDGET_MS;
      const budgetStart = performance.now();
      let processed = 0;
      let cursor = EditorState.playerTickCursor % totalPlayers;
      while (processed < totalPlayers) {
        const p = State.players[cursor];
        if (p) p.tick(now);
        cursor = (cursor + 1) % totalPlayers;
        processed++;
        if (processed < totalPlayers && performance.now() - budgetStart > budgetMs) break;
      }
      EditorState.playerTickCursor = cursor;
    }

    requestAnimationFrame(tick);
  }
  function bindEvents(): void {
    const ui = DOM.uiElements;

    ui.dropImageZone.onclick = () => ui.imageInput.click();
    ui.imageInput.onchange   = async e => {
      const files = (e.target as HTMLInputElement).files;
      if (files) {
        try {
          await handleImageUpload(files);
        } catch (err) {
          console.error('Error handling uploaded images:', err);
        }
      }
    };

    ui.startButton.onclick = async () => {
      if (State.data.availableWorlds.length === 0) return;

      // 启动时立即合成全部 plant packet 并预热植物动画缓存
      const ok = await handleStartViewer();
      if (!ok) return;

      ui.introModal.style.display = 'none';
      const sideR = document.getElementById('sidebar-right');
      if (sideR) sideR.style.display = 'block';

      // 地图区域为空，由用户手动选择
      populateWorldSelector();
      if (DOM.uiElements.selectWorld) {
        DOM.uiElements.selectWorld.value = '';
      }
      handleResetCamera();
    };

    // Close button on left inspector sidebar
    const btnInspectorClose = document.getElementById('btn-inspector-close');
    if (btnInspectorClose) {
      btnInspectorClose.onclick = () => {
        clearSelection();
      };
    }

    // Help guidelines modal
    const btnHelp = document.getElementById('btn-help');
    const helpOverlay = document.getElementById('help-modal-overlay');
    const btnHelpClose = document.getElementById('btn-help-modal-close');
    const btnHelpOk = document.getElementById('btn-help-modal-ok');

    if (btnHelp && helpOverlay) {
      btnHelp.onclick = () => {
        helpOverlay.style.display = 'flex';
      };
    }
    if (btnHelpClose && helpOverlay) {
      btnHelpClose.onclick = () => {
        helpOverlay.style.display = 'none';
      };
    }
    if (btnHelpOk && helpOverlay) {
      btnHelpOk.onclick = () => {
        helpOverlay.style.display = 'none';
      };
    }

    // Checkboxes change redraw triggering
    const isoCheck = document.getElementById('isometric-grid-checkbox') as HTMLInputElement | null;
    if (isoCheck) {
      isoCheck.onchange = () => {
        EditorState.cameraDirty = true;
      };
    }
    const boundsCheck = document.getElementById('bounding-rect-checkbox') as HTMLInputElement | null;
    if (boundsCheck) {
      boundsCheck.onchange = () => {
        EditorState.cameraDirty = true;
      };
    }

    // Restart button handler
    const btnRestart = document.getElementById('btn-restart');
    if (btnRestart) {
      btnRestart.onclick = async () => {
        const ok = await showConfirmModal(
            '确定要重新启动编辑器并返回上传页面吗？所有未保存的编辑内容都将丢失。\n\nAre you sure you want to restart the editor and return to the upload screen? All unsaved changes will be lost.'
        );
        if (ok) {
          await unloadResourcePack(handleResetCamera);
          // Hide sidebars and toolbar controls
          const sideR = document.getElementById('sidebar-right');
          if (sideR) sideR.style.display = 'none';
          const toolbarMiddle = document.getElementById('toolbar-middle-controls');
          if (toolbarMiddle) toolbarMiddle.style.display = 'none';
          const toolbarRight = document.getElementById('toolbar-right-controls');
          if (toolbarRight) toolbarRight.style.display = 'none';
          const controlsBar = document.getElementById('controls-bar');
          if (controlsBar) controlsBar.style.display = 'none';
        }
      };
    }

    ui.btnClear.onclick = async () => {
      if (State.data.mapConfig) {
        const confirmUnload = await showConfirmModal(
            '确定要清除当前渲染并卸载世界吗？所有未保存的编辑都将丢失。\n\nAre you sure you want to clear the active render and unload the world? Unsaved edits will be lost.'
        );
        if (confirmUnload) {
          await clearAll(handleResetCamera);
          showToast('已卸载世界地图');
        }
      } else {
        await clearAll(handleResetCamera);
      }
    };

    if (ui.btnUnloadPack) {
      ui.btnUnloadPack.onclick = async () => {
        const hasPack =
            State.data.availableWorlds.length > 0 ||
            Object.keys(State.data.globalFiles || {}).length > 0 ||
            (State.data.indexedFiles && State.data.indexedFiles.size > 0);

        if (!hasPack) {
          showToast('当前没有已加载的资源包');
          // 仍回到首页，避免卡在空白编辑器
          if (DOM.uiElements.introModal) {
            DOM.uiElements.introModal.style.display = 'flex';
          }
          const sideR = document.getElementById('sidebar-right');
          if (sideR) sideR.style.display = 'none';
          return;
        }

        const ok = await showConfirmModal(
            '确定要卸载全部已上传资源包并返回首页吗？\n地图编辑未保存内容将丢失，内存中的文件索引与缓存都会被清除。\n\nUnload the entire uploaded asset pack and return to the home screen? Unsaved edits will be lost.'
        );
        if (!ok) return;

        try {
          await unloadResourcePack(handleResetCamera);
        } catch (err) {
          console.error('[UnloadPack]', err);
          hideGlobalLoading();
          showToast('卸载失败，请查看控制台');
        }
      };
    }

    // 1. Left modes
    if (ui.modeIsland) {
      ui.modeIsland.onclick = () => {
        EditorState.toolMode = 'island';
        EditorState.isPanActive = false;
        EditorState.drawSubMode = 'move';
        clearSelection();
        updateToolbarState();
        showToast('岛屿模式已启用：请先激活 添加/移动/翻转/旋转/删除，再点击地图元素');
      };
    }
    if (ui.modeDoodad) {
      ui.modeDoodad.onclick = () => {
        EditorState.toolMode = 'doodad';
        EditorState.isPanActive = false;
        EditorState.drawSubMode = 'move';
        clearSelection();
        updateToolbarState();
        showToast('装饰物模式已启用：请先激活 添加/移动/翻转/旋转/删除，再点击地图元素');
      };
    }
    if (ui.modeEvent) {
      ui.modeEvent.onclick = () => {
        EditorState.toolMode = 'event';
        EditorState.isPanActive = false;
        EditorState.drawSubMode = 'none';
        EditorState.eventSubMode = 'edit';
        clearSelection();
        updateToolbarState();
        showToast('事件模式已启用：可从工具栏选择 添加/移动/编辑/删除');
      };
    }
    if (ui.modeSelect) {
      ui.modeSelect.onclick = () => {
        EditorState.toolMode = 'select';
        EditorState.isPanActive = false;
        EditorState.drawSubMode = 'none';
        clearSelection();
        updateToolbarState();
        showToast('选择模式已启用：点击任意元素进行选择');
      };
    }

    // 2. Global toggles
    if (ui.btnPan) {
      ui.btnPan.onclick = () => {
        EditorState.isPanActive = !EditorState.isPanActive;
        if (EditorState.isPanActive) {
          EditorState.drawSubMode = 'none'; // 与 Island/Doodad 子工具互斥
          EditorState.eventSubMode = 'move';
          clearSelection();
        }
        updateToolbarState();
        showToast(EditorState.isPanActive ? '平移模式已启用' : '编辑模式已启用');
      };
    }
    if (ui.btnSnapToggle) {
      ui.btnSnapToggle.onclick = () => {
        State.data.moveSnapEnabled = !State.data.moveSnapEnabled;
        updateToolbarState();
        showToast(State.data.moveSnapEnabled ? '已开启网格吸附' : '已关闭网格吸附');
      };
    }
    if (ui.btnMapOnly) {
      ui.btnMapOnly.onclick = () => {
        State.data.isMapOnly = !State.data.isMapOnly;
        updateToolbarState();
        applyMapOnlyVisibility();
        showToast(State.data.isMapOnly ? '仅地图视图已开启' : '完整视图已开启');
      };
    }

    // 3. Middle Island/Doodad Buttons
    if (ui.btnAdd) {
      ui.btnAdd.onclick = () => {
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        setDrawSubMode('add');
        showToast(EditorState.drawSubMode === 'add' ? '添加已激活：点击地图空白处放置' : '添加已关闭');
      };
    }
    if (ui.btnMove) {
      ui.btnMove.onclick = () => {
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        setDrawSubMode('move');
        showToast(EditorState.drawSubMode === 'move' ? '移动已激活：拖拽 hitbox 移动' : '移动已关闭');
      };
    }
    if (ui.btnImgPrev) {
      ui.btnImgPrev.onclick = async () => {
        if (EditorState.selectedPieceRef) {
          const node = getSelectedNode(EditorState.selectedPieceRef);
          if (!node) return;
          const nextId = cycleImageId(node.m_imageID ?? 0, -1);
          node.m_imageID = nextId;
          await refreshSingleObject(node, 'reload');
          showToast(`Image ID → ${nextId}`);
        } else {
          EditorState.defaultImageID = cycleImageId(EditorState.defaultImageID, -1);
          showToast(`默认 Image ID 已设为 ${EditorState.defaultImageID}`);
        }
        updateToolbarState();
      };
    }
    if (ui.btnImgNext) {
      ui.btnImgNext.onclick = async () => {
        if (EditorState.selectedPieceRef) {
          const node = getSelectedNode(EditorState.selectedPieceRef);
          if (!node) return;
          const nextId = cycleImageId(node.m_imageID ?? 0, 1);
          node.m_imageID = nextId;
          await refreshSingleObject(node, 'reload');
          showToast(`Image ID → ${nextId}`);
        } else {
          EditorState.defaultImageID = cycleImageId(EditorState.defaultImageID, 1);
          showToast(`默认 Image ID 已设为 ${EditorState.defaultImageID}`);
        }
        updateToolbarState();
      };
    }
    if (ui.btnCurLayer) {
      ui.btnCurLayer.onclick = () => {
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        EditorState.isCurLayerActive = !EditorState.isCurLayerActive;
        updateToolbarState();
        showToast(
            EditorState.isCurLayerActive
                ? `CurLayer 已激活：覆盖层已隐藏，默认层 ${EditorState.defaultDrawLayer}`
                : 'CurLayer 已关闭：全部显示'
        );
      };
    }
    if (ui.btnLayerDec) {
      ui.btnLayerDec.onclick = () => {
        if (!EditorState.isCurLayerActive) return;
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        EditorState.defaultDrawLayer = Math.max(-36, EditorState.defaultDrawLayer - 1);
        updateToolbarState();
        showToast(`默认绘制图层 → ${EditorState.defaultDrawLayer}`);
      };
    }
    if (ui.btnLayerInc) {
      ui.btnLayerInc.onclick = () => {
        if (!EditorState.isCurLayerActive) return;
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        EditorState.defaultDrawLayer = Math.min(10, EditorState.defaultDrawLayer + 1);
        updateToolbarState();
        showToast(`默认绘制图层 → ${EditorState.defaultDrawLayer}`);
      };
    }
    if (ui.btnRotation) {
      ui.btnRotation.onclick = () => {
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        setDrawSubMode('rotation');
        showToast(EditorState.drawSubMode === 'rotation' ? '旋转已激活：点击 hitbox 打开旋转面板' : '旋转已关闭');
      };
    }
    if (ui.btnFlip) {
      ui.btnFlip.onclick = () => {
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        setDrawSubMode('flip');
        showToast(EditorState.drawSubMode === 'flip' ? '翻转已激活：点击 hitbox 切换水平翻转' : '翻转已关闭');
      };
    }
    if (ui.btnDelete) {
      ui.btnDelete.onclick = () => {
        if (EditorState.toolMode !== 'island' && EditorState.toolMode !== 'doodad') return;
        setDrawSubMode('delete');
        showToast(EditorState.drawSubMode === 'delete' ? '删除已激活：点击 hitbox 删除' : '删除已关闭');
      };
    }

    // 4. Middle Event Buttons
    if (ui.btnEventType) {
      ui.btnEventType.onclick = () => {
        const idx = EVENT_TYPE_CYCLE.indexOf(EditorState.pendingEventType);
        EditorState.pendingEventType = EVENT_TYPE_CYCLE[(idx + 1) % EVENT_TYPE_CYCLE.length];
        updateToolbarState();
        showToast(`已选择事件类型：${EditorState.pendingEventType}`);
      };
    }
    if (ui.btnEventAdd) {
      ui.btnEventAdd.onclick = () => {
        EditorState.isPanActive = false;
        if (EditorState.eventSubMode === 'add') {
          EditorState.eventSubMode = 'move';
          showToast('已切换到事件移动模式');
        } else {
          EditorState.eventSubMode = 'add';
          showToast('事件添加已启用：点击地图放置节点');
        }
        updateToolbarState();
      };
    }
    if (ui.btnEventMove) {
      ui.btnEventMove.onclick = () => {
        EditorState.isPanActive = false;
        if (EditorState.eventSubMode === 'move') {
          EditorState.eventSubMode = 'none';
          showToast('事件移动已关闭');
        } else {
          EditorState.eventSubMode = 'move';
          showToast('事件移动已启用：拖拽节点调整位置');
        }
        updateToolbarState();
      };
    }
    if (ui.btnEventEdit) {
      ui.btnEventEdit.onclick = () => {
        EditorState.isPanActive = false;
        if (EditorState.eventSubMode === 'edit') {
          EditorState.eventSubMode = 'move';
          showToast('已切换到事件移动模式');
        } else {
          EditorState.eventSubMode = 'edit';
          showToast('事件编辑已启用：点击事件节点编辑属性');
        }
        updateToolbarState();
      };
    }
    if (ui.btnEventDelete) {
      ui.btnEventDelete.onclick = () => {
        EditorState.isPanActive = false;
        if (EditorState.eventSubMode === 'delete') {
          EditorState.eventSubMode = 'move';
          showToast('已切换到事件移动模式');
        } else {
          EditorState.eventSubMode = 'delete';
          showToast('事件删除已启用：点击事件节点即可删除');
        }
        updateToolbarState();
      };
    }
    if (ui.btnAppend) {
      ui.btnAppend.onclick = async () => {
        if (EditorState.selectedPieceRef && isEventPieceRef(EditorState.selectedPieceRef)) {
          const parentNode = EditorState.selectedPieceRef.node;
          const mapX = (parentNode.m_position?.x ?? 0) + 80;
          const mapY = parentNode.m_position?.y ?? 0;
          const newPathNode = addNewEventNode('path_node', mapX, mapY, parentNode.m_name);
          if (newPathNode) {
            await mountNewObject(newPathNode, 'event');
            showToast('已追加连接到父节点的 path_node');
          }
        }
      };
    }

    // 5. Select Action
    if (ui.btnSelectDelete) {
      ui.btnSelectDelete.onclick = async () => {
        if (EditorState.selectedPieceRef) {
          const node = getSelectedNode(EditorState.selectedPieceRef);
          const confirmDel = await showConfirmModal('确定删除选中的节点吗？\n\nAre you sure you want to delete this node?');
          if (confirmDel) {
            deletePieceOrNode(node);
            await refreshSingleObject(node, 'remove');
            showToast('已删除选中节点');
          }
        }
      };
    }

    if (ui.btnSaveMap) ui.btnSaveMap.onclick = handleSaveMap;
    if (ui.btnResetMap) ui.btnResetMap.onclick = handleResetMap;

    // Global Key Bindings for pro map editing speed
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'p' || e.key === 'P') {
        EditorState.isPanActive = !EditorState.isPanActive;
        if (EditorState.isPanActive) {
          EditorState.drawSubMode = 'none';
          EditorState.eventSubMode = 'move';
          clearSelection();
        }
        updateToolbarState();
        showToast(EditorState.isPanActive ? '已切换到平移模式' : '编辑模式已启用');
      } else if (e.key === 'i' || e.key === 'I') {
        EditorState.toolMode = 'island';
        EditorState.isPanActive = false;
        EditorState.drawSubMode = 'move';
        clearSelection();
        updateToolbarState();
        showToast('已切换到岛屿绘制模式');
      } else if (e.key === 'd' || e.key === 'D') {
        EditorState.toolMode = 'doodad';
        EditorState.isPanActive = false;
        EditorState.drawSubMode = 'move';
        clearSelection();
        updateToolbarState();
        showToast('已切换到装饰物绘制模式');
      } else if (e.key === 'e' || e.key === 'E') {
        EditorState.toolMode = 'event';
        EditorState.isPanActive = false;
        EditorState.eventSubMode = 'edit';
        clearSelection();
        updateToolbarState();
        showToast('已切换到事件放置模式');
      } else if (e.key === 's' || e.key === 'S') {
        EditorState.toolMode = 'select';
        EditorState.isPanActive = false;
        clearSelection();
        updateToolbarState();
        showToast('已切换到选择模式');
      } else if ((e.key === 'r' || e.key === 'R') && EditorState.selectedPieceRef) {
        if (ui.btnRotation && !ui.btnRotation.disabled) {
          ui.btnRotation.click();
        }
      } else if ((e.key === 'f' || e.key === 'F') && EditorState.selectedPieceRef) {
        if (ui.btnFlip && !ui.btnFlip.disabled) {
          ui.btnFlip.click();
        }
      } else if (e.key === 'f' || e.key === 'F') {
        if (EditorState.toolMode === 'island' || EditorState.toolMode === 'doodad') {
          if (ui.btnFlip) ui.btnFlip.click();
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && EditorState.selectedPieceRef) {
        e.preventDefault();
        const isDeletableByDeleteBtn = isMapPieceRef(EditorState.selectedPieceRef) || isDoodadRef(EditorState.selectedPieceRef);
        if (isDeletableByDeleteBtn) {
          if (ui.btnDelete && !ui.btnDelete.disabled) ui.btnDelete.click();
        } else {
          if (ui.btnEventDelete && !ui.btnEventDelete.disabled) ui.btnEventDelete.click();
        }
      } else if (e.key === 'm' || e.key === 'M') {
        State.data.isMapOnly = !State.data.isMapOnly;
        updateToolbarState();
        applyMapOnlyVisibility();
        if (State.data.isMapOnly) {
          showToast('仅地图模式（事件节点已隐藏）');
        } else {
          showToast('完整渲染模式（全部元素已显示）');
        }
      } else if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
        if (State.data.mapConfig) {
          e.preventDefault();
          handleSaveMap();
        }
      }
    });

    if (ui.selectWorld) {
      ui.selectWorld.onchange = async (e) => {
        const worldName = (e.target as HTMLSelectElement).value;
        try {
          await handleWorldSelect(worldName);
        } catch (err) {
          console.error('Error selecting world:', err);
        }
      };
    }

    ui.checkUnlockAll.onchange = async (e) => {
      State.data.unlockAll = (e.target as HTMLInputElement).checked;
      if (State.data.mapConfig) {
        await runWithDeferredLoading(
            '正在重新解析事件资源…',
            '解锁全部: ' + (State.data.unlockAll ? '开' : '关'),
            () => triggerMapRender({ eventOnly: true })
        );
      }
    };

    if (ui.checkChinaVersion) {
      ui.checkChinaVersion.checked = State.data.isChinaVersion;
      ui.checkChinaVersion.onchange = async (e) => {
        State.data.isChinaVersion = (e.target as HTMLInputElement).checked;

        // Before a resource pack is uploaded, this checkbox is a purely preparatory setting -
        // declaring which version the pack about to be selected is. Start-time preload already
        // reads State.data.isChinaVersion fresh (see preloadAllMapAssets.ts / plantTypes.ts),
        // so there's nothing to rebuild yet and no reason to show any loading/toast feedback
        // here. Only re-derive below for the genuine mid-session case: a pack is already loaded
        // and the user is deliberately switching versions.
        if (State.data.availableWorlds.length === 0) return;

        // 外层持有 loading：handleRebuildPlantAssets 内部会自行 show/hide，但 loading.ts 的
        // depth 计数器会把它接住，避免遮罩在 triggerMapRender 之前就被提前关闭。
        showGlobalLoading('正在切换版本…', '重新装载 packet 元数据');
        await nextFrame();
        await yieldToBrowser();
        try {
          // 按新版本标志重新从 resource_manifest 装载 packet 偏移，并重建植物预热缓存
          await loadPlantPacketMetadata();
          clearComposedPacketCache();
          clearEventResourceCache();
          await handleRebuildPlantAssets();
          if (State.data.mapConfig) {
            updateGlobalLoading('正在切换版本…', '重新渲染地图');
            await triggerMapRender();
          }
          await nextFrame();
          await yieldToBrowser();
        } finally {
          hideGlobalLoading();
        }
        showToast(
            State.data.isChinaVersion
                ? '已切换为中国版资源路径，植物资源已重建'
                : '已切换为国际版资源路径，植物资源已重建'
        );
      };
    }

    if (ui.checkIsLinear) {
      ui.checkIsLinear.checked = State.data.isLinear;
      ui.checkIsLinear.onchange = (e) => {
        State.data.isLinear = (e.target as HTMLInputElement).checked;
      };
    }

    ui.selectTextureRes.onchange = async (e) => {
      State.data.textureResolution = Number((e.target as HTMLSelectElement).value);
      showGlobalLoading('正在切换分辨率…', `分辨率 → ${State.data.textureResolution}`);
      await nextFrame();
      await yieldToBrowser();
      try {
        // Start 时已对 1536/768 两档分辨率完整预热（mapPiece/doodad 静态图+动画、每个 event
        // 节点在三种状态下的解析结果），这里不再需要 clearAllRuntimeCaches + 全量重建植物资源
        // ——那一套是为了兼容旧逻辑保留的 fallback，如今绝大部分资源都已经是缓存命中。
        rebuildWorldAssets();
        if (State.data.selectedWorld && State.data.mapConfig) {
          // 轻量兜底：补齐预热未覆盖的部分（如路径瓦片贴图），大多数调用会直接命中缓存。
          await preloadWorldResources(State.data.selectedWorld, State.data.mapConfig, State.data.textureResolution);
          updateGlobalLoading('正在切换分辨率…', '重新渲染地图');
          await triggerMapRender();
          await nextFrame();
          await yieldToBrowser();
        }
      } finally {
        hideGlobalLoading();
      }
    };

    ui.resetButton.onclick   = handleResetCamera;

    const handleDrag = (e: MouseEvent) => {
      // ---------- 对象拖拽分支（优先于 Pan） ----------
      if (EditorState.isDraggingPiece && EditorState.selectedPieceRef) {
        applyDragMove(e);
        return; // 对象拖拽结束，不进入 Pan 逻辑
      }

      // ---------- 原有 Pan 平移逻辑（保持不变） ----------
      if (!State.interaction.isDragging) return;
      const deltaX = e.clientX - State.interaction.lastMouseX;
      const deltaY = e.clientY - State.interaction.lastMouseY;
      State.interaction.velocityX = deltaX;
      State.interaction.velocityY = deltaY;
      EditorState.targetCamera.x += deltaX / State.camera.scale;
      EditorState.targetCamera.y += deltaY / State.camera.scale;
      State.interaction.lastMouseX = e.clientX;
      State.interaction.lastMouseY = e.clientY;
    };

    DOM.viewport.onmousedown = async (e) => {
      if (e.button !== 0) return;

      const target = e.target as HTMLElement;
      if (
          target.closest('#editor-toolbar') ||
          target.closest('#sidebar-right') ||
          target.closest('.controls-bar') ||
          target.closest('#intro-modal') ||
          target.closest('#confirm-modal-overlay') ||
          target.closest('.modal') ||
          target.closest('.modal-overlay') ||
          target.closest('.event-editor-overlay') ||
          target.closest('.event-editor-modal') ||
          target.closest('#toast') ||
          target.closest('.editor-toast') ||
          target.closest('#rotate-panel')
      ) {
        return;
      }
      if (hasActiveRotateTarget()) {
        if (target.closest('#rotate-panel')) return;
        return;
      }
      const rect = DOM.viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const worldPos = CoordinateSystem.screenToWorld(mouseX, mouseY);
      const scale = State.data.textureResolution / 600;
      const mapX = worldPos.x / scale;
      const mapY = worldPos.y / scale;

      // 1. PAN is active
      if (EditorState.isPanActive) {
        State.interaction.isDragging  = true;
        State.interaction.lastMouseX  = e.clientX;
        State.interaction.lastMouseY  = e.clientY;
        State.interaction.velocityX   = 0;
        State.interaction.velocityY   = 0;
        DOM.viewport.style.cursor     = 'grabbing';
        return;
      }

      // 2. Select mode
      if (EditorState.toolMode === 'select') {
        const matchPiece = State.data.pieces.find(p => p.element.contains(e.target as Node));
        const matchEvent = State.data.eventPieces.find(p => p.element.contains(e.target as Node));
        const selectedRef: any = matchPiece || matchEvent;

        if (selectedRef) {
          selectPiece(selectedRef);
          EditorState.isDraggingPiece = true;
          EditorState.hasActuallyDragged = false;
          EditorState.dragStartMousePos.x = e.clientX;
          EditorState.dragStartMousePos.y = e.clientY;

          const node = selectedRef.piece || selectedRef.node;
          EditorState.dragStartPiecePos.x = node.m_position?.x || 0;
          EditorState.dragStartPiecePos.y = node.m_position?.y || 0;

          e.stopPropagation();
        } else {
          clearSelection();
        }
        return;
      }

      // 3. Island mode — 必须先激活子工具，再点 hitbox
      if (EditorState.toolMode === 'island') {
        if (EditorState.drawSubMode === 'none') {
          showToast('请先激活 添加 / 移动 / 翻转 / 旋转 / 删除');
          return;
        }
        if (EditorState.drawSubMode === 'add') {
          const newPiece = addNewMapPiece(mapX, mapY);
          if (newPiece) {
            await mountNewObject(newPiece, 'piece');
            showToast('已放置新的地图元素');
          }
          return;
        }
        const selectedRef = State.data.pieces.find(p => p.element.contains(e.target as Node));
        if (!selectedRef) {
          clearSelection();
          return;
        }
        selectPiece(selectedRef);
        const node = selectedRef.piece;
        e.stopPropagation();

        if (EditorState.drawSubMode === 'move') {
          EditorState.isDraggingPiece = true;
          EditorState.hasActuallyDragged = false;
          EditorState.dragStartMousePos.x = e.clientX;
          EditorState.dragStartMousePos.y = e.clientY;
          EditorState.dragStartPiecePos.x = node.m_position?.x || 0;
          EditorState.dragStartPiecePos.y = node.m_position?.y || 0;
        } else if (EditorState.drawSubMode === 'flip') {
          await flipNode(node, 'transform');
        } else if (EditorState.drawSubMode === 'rotation') {
          openRotatePanel(node, 'piece');
        } else if (EditorState.drawSubMode === 'delete') {
          const confirmDel = await showConfirmModal('确定删除选中的岛屿元素吗？\n\nDelete this map piece?');
          if (confirmDel) {
            deletePieceOrNode(node);
            await refreshSingleObject(node, 'remove');
            showToast('已删除地图元素');
          }
        }
        return;
      }

      // 4. Doodad mode — 必须先激活子工具，再点 hitbox
      if (EditorState.toolMode === 'doodad') {
        if (EditorState.drawSubMode === 'none') {
          showToast('请先激活 添加 / 移动 / 翻转 / 旋转 / 删除');
          return;
        }
        if (EditorState.drawSubMode === 'add') {
          const newDoodad = addNewDoodad(mapX, mapY);
          if (newDoodad) {
            await mountNewObject(newDoodad, 'doodad');
            showToast('已放置新的装饰物');
          }
          return;
        }
        const selectedRef = State.data.eventPieces.find(
            p => p.element.contains(e.target as Node) && p.node.m_eventType === 'doodad'
        );
        if (!selectedRef) {
          clearSelection();
          return;
        }
        selectPiece(selectedRef);
        const node = selectedRef.node;
        e.stopPropagation();

        if (EditorState.drawSubMode === 'move') {
          EditorState.isDraggingPiece = true;
          EditorState.hasActuallyDragged = false;
          EditorState.dragStartMousePos.x = e.clientX;
          EditorState.dragStartMousePos.y = e.clientY;
          EditorState.dragStartPiecePos.x = node.m_position?.x || 0;
          EditorState.dragStartPiecePos.y = node.m_position?.y || 0;
        } else if (EditorState.drawSubMode === 'flip') {
          await flipNode(node, 'reload');
        } else if (EditorState.drawSubMode === 'rotation') {
          openRotatePanel(node, 'doodad');
        } else if (EditorState.drawSubMode === 'delete') {
          const confirmDel = await showConfirmModal('确定删除选中的装饰物吗？\n\nDelete this doodad?');
          if (confirmDel) {
            deletePieceOrNode(node);
            await refreshSingleObject(node, 'remove');
            showToast('已删除装饰物');
          }
        }
        return;
      }

      // 5. Event mode
      if (EditorState.toolMode === 'event') {
        const matchEvent = State.data.eventPieces.find(p => p.element.contains(e.target as Node) && p.node.m_eventType !== 'doodad');

        if (EditorState.eventSubMode === 'move') {
          if (matchEvent) {
            selectPiece(matchEvent);
            EditorState.isDraggingPiece = true;
            finalizeDragPathUpdate();
            EditorState.hasActuallyDragged = false;
            EditorState.dragStartMousePos.x = e.clientX;
            EditorState.dragStartMousePos.y = e.clientY;

            const node = matchEvent.node;
            EditorState.dragStartPiecePos.x = node.m_position?.x || 0;
            EditorState.dragStartPiecePos.y = node.m_position?.y || 0;
            e.stopPropagation();
          } else {
            clearSelection();
          }
        } else if (EditorState.eventSubMode === 'edit') {
          if (matchEvent) {
            selectPiece(matchEvent);
            openEventEditorModal(matchEvent.node);
            e.stopPropagation();
          } else {
            clearSelection();
          }
        } else if (EditorState.eventSubMode === 'delete') {
          if (matchEvent) {
            selectPiece(matchEvent);
            e.stopPropagation();
            showConfirmModal('确定删除这个事件节点吗？\n\nAre you sure you want to delete this event node?').then((confirmDel) => {
              if (confirmDel) {
                deletePieceOrNode(matchEvent.node);
                triggerMapRender().then(() => {
                  clearSelection();
                  showToast('已删除事件节点');
                });
              }
            });
          } else {
            clearSelection();
          }
        } else if (EditorState.eventSubMode === 'add') {
          const newNode = addNewEventNode(EditorState.pendingEventType, mapX, mapY);
          if (newNode) {
            await mountNewObject(newNode, 'event');
            showToast(`已放置新的 ${EditorState.pendingEventType} 节点`);
          }
        }
        return;
      }
    };

    window.onmousemove = handleDrag;
    window.onmouseup = async () => {
      if (EditorState.isDraggingPiece) {
        EditorState.isDraggingPiece = false;
        if (EditorState.selectedPieceRef && EditorState.hasActuallyDragged) {
          autoSaveToLocalStorage();
          // 位置已在 mousemove fast-path 写好，不要 triggerMapRender
        } else if (EditorState.selectedPieceRef && !EditorState.hasActuallyDragged && EditorState.toolMode === 'event' && EditorState.eventSubMode === 'edit') {
          const node = getSelectedNode(EditorState.selectedPieceRef);
          if (node && node.m_eventType !== 'doodad') {
            openEventEditorModal(node);
          }
        }
      }
      State.interaction.isDragging = false;
      DOM.viewport.style.cursor = EditorState.isPanActive ? 'grab' : 'default';
    };

    DOM.viewport.onwheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect       = DOM.viewport.getBoundingClientRect();
      const mx         = e.clientX - rect.left;
      const my         = e.clientY - rect.top;

      // Camera coordinates math tracking
      const targetWorldMatrix = Matrix.multiply(
          Matrix.scale(EditorState.targetCamera.scale, EditorState.targetCamera.scale),
          Matrix.translate(EditorState.targetCamera.x, EditorState.targetCamera.y)
      );
      const invTargetMatrix = Matrix.inverse(targetWorldMatrix);
      const targetWorldPoint = Matrix.transformPoint(invTargetMatrix, mx, my);

      const factor     = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale   = ZoomHelper.clamp(EditorState.targetCamera.scale * factor, DOM.viewport.clientHeight);
      if (newScale === EditorState.targetCamera.scale) return;
      EditorState.targetCamera.scale = newScale;
      EditorState.targetCamera.x     = (mx / newScale) - targetWorldPoint.x;
      EditorState.targetCamera.y     = (my / newScale) - targetWorldPoint.y;
    };

    const dropZone = ui.dropImageZone;
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '#c4a052';
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = '#3f3f46';
    });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '#3f3f46';
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        const items = e.dataTransfer.items;
        const collectedFiles: File[] = [];

        const traverseEntry = async (entry: any): Promise<void> => {
          if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
            Object.defineProperty(file, 'customPath', {
              value: entry.fullPath.replace(/^\//, ''),
              writable: false
            });
            collectedFiles.push(file);
          } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const readAllEntries = async (): Promise<any[]> => {
              const result: any[] = [];
              try {
                let batch = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject));
                while (batch.length > 0) {
                  result.push(...batch);
                  batch = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject));
                }
              } catch (err) {
                console.error('[WorldMap Drop Entry Error]', err);
              }
              return result;
            };
            const entries = await readAllEntries();
            for (const child of entries) {
              await traverseEntry(child);
            }
          }
        };

        const entriesPromises = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'file') {
            const entry = (item as any).webkitGetAsEntry ? (item as any).webkitGetAsEntry() : null;
            if (entry) {
              entriesPromises.push(traverseEntry(entry));
            } else {
              const f = item.getAsFile();
              if (f) collectedFiles.push(f);
            }
          }
        }

        if (entriesPromises.length > 0) {
          await Promise.all(entriesPromises);
        } else {
          for (let i = 0; i < e.dataTransfer.files.length; i++) {
            collectedFiles.push(e.dataTransfer.files[i]);
          }
        }

        if (collectedFiles.length > 0) {
          try {
            await handleImageUpload(collectedFiles);
          } catch (err) {
            console.error('Error handling dropped images:', err);
          }
        }
      }
    });

    window.addEventListener('trigger-map-render', () => {
      // Fired by EventLoader's status/star preview toggles - only event resources change,
      // so eventOnly is sufficient and avoids re-mounting the (usually much larger) map-piece
      // layer. Every (node × status × resolution) combination is warmed at Start, so this is
      // normally a cache-hit render; deferred loading only shows if it's actually slow.
      runWithDeferredLoading('正在更新预览状态…', '', () => triggerMapRender({ eventOnly: true }));
    });
  }
  function init(): void {
    setTriggerMapRender(triggerMapRender);
    bindEvents();
    bindRotatePanel();
    initBBox();
    window.addEventListener('resize', () => {
      initBBox();
      EditorState.cameraDirty = true;
      handleResetCamera();
    });
    requestAnimationFrame(tick);
  }

  return { init };
})();