import { State } from '../core/state';
import { DOM } from '../app/dom';
import { EditorState } from '../editor/EditorState';
import { isDoodadRef, isEventNodeRef, isMapPieceRef } from '../editor/types';
import { applyDrawLayerFilter } from '../editor/ObjectMount';

/** 切换 Island/Doodad 子工具；再次点击同一按钮则关闭；开启时自动关掉 Pan */
export function setDrawSubMode(mode: typeof EditorState.drawSubMode): void {
  if (EditorState.drawSubMode === mode) {
    EditorState.drawSubMode = 'none';
  } else {
    EditorState.drawSubMode = mode;
    EditorState.isPanActive = false;
  }
  updateToolbarState();
}

export function updateToolbarState(): void {
  const ui = DOM.uiElements;
  const selectedPieceRef = EditorState.selectedPieceRef;
  const toolMode = EditorState.toolMode;
  const drawSubMode = EditorState.drawSubMode;
  const eventSubMode = EditorState.eventSubMode;
  const isPanActive = EditorState.isPanActive;
  const isCurLayerActive = EditorState.isCurLayerActive;
  const defaultDrawLayer = EditorState.defaultDrawLayer;
  const pendingEventType = EditorState.pendingEventType;

  const hasSelection = !!selectedPieceRef;
  const isEventNode = selectedPieceRef && isEventNodeRef(selectedPieceRef);
  // Highlight left modes
  if (ui.modeIsland) {
    if (toolMode === 'island') ui.modeIsland.classList.add('active');
    else ui.modeIsland.classList.remove('active');
  }
  if (ui.modeDoodad) {
    if (toolMode === 'doodad') ui.modeDoodad.classList.add('active');
    else ui.modeDoodad.classList.remove('active');
  }
  if (ui.modeEvent) {
    if (toolMode === 'event') ui.modeEvent.classList.add('active');
    else ui.modeEvent.classList.remove('active');
  }
  if (ui.modeSelect) {
    if (toolMode === 'select') ui.modeSelect.classList.add('active');
    else ui.modeSelect.classList.remove('active');
  }

  // Toggle middle sub-toolbars visibility
  if (ui.middleIslandDoodad) ui.middleIslandDoodad.style.display = (toolMode === 'island' || toolMode === 'doodad') ? 'flex' : 'none';
  if (ui.middleEvent) ui.middleEvent.style.display = (toolMode === 'event') ? 'flex' : 'none';
  if (ui.middleSelect) ui.middleSelect.style.display = (toolMode === 'select') ? 'flex' : 'none';

  // Update global buttons status
  if (ui.btnPan) {
    if (isPanActive) ui.btnPan.classList.add('active');
    else ui.btnPan.classList.remove('active');
  }
  if (ui.btnSnapToggle) {
    if (State.data.moveSnapEnabled) ui.btnSnapToggle.classList.add('active');
    else ui.btnSnapToggle.classList.remove('active');
  }
  if (ui.btnMapOnly) {
    if (State.data.isMapOnly) ui.btnMapOnly.classList.add('active');
    else ui.btnMapOnly.classList.remove('active');
  }

  // Update Island/Doodad middle controls — Add/Move/Flip/Rotation/Delete 互斥激活，且与 Pan 互斥
  if (toolMode === 'island' || toolMode === 'doodad') {
    const subActive = !isPanActive;
    const setActive = (btn: HTMLButtonElement | null, on: boolean) => {
      if (!btn) return;
      btn.disabled = false;
      if (on) btn.classList.add('active');
      else btn.classList.remove('active');
    };
    setActive(ui.btnAdd, subActive && drawSubMode === 'add');
    setActive(ui.btnMove, subActive && drawSubMode === 'move');
    setActive(ui.btnFlip, subActive && drawSubMode === 'flip');
    setActive(ui.btnRotation, subActive && drawSubMode === 'rotation');
    setActive(ui.btnDelete, subActive && drawSubMode === 'delete');


    if (ui.btnCurLayer) {
      ui.btnCurLayer.disabled = false;
      ui.btnCurLayer.textContent = 'CurLayer';
      ui.btnCurLayer.title = `默认绘制层: ${defaultDrawLayer}（激活：隐藏覆盖层 + 按层过滤 mapPiece；关闭：全部显示）`;
      if (isCurLayerActive) ui.btnCurLayer.classList.add('active');
      else ui.btnCurLayer.classList.remove('active');
    }
    if (ui.btnLayerDec) {
      ui.btnLayerDec.disabled = !isCurLayerActive;
      ui.btnLayerDec.classList.remove('active');
    }
    if (ui.btnLayerInc) {
      ui.btnLayerInc.disabled = !isCurLayerActive;
      ui.btnLayerInc.classList.remove('active');
    }
  }

  // Update Event middle controls
  if (toolMode === 'event') {
    if (ui.btnEventType) {
      ui.btnEventType.textContent = `Type: ${pendingEventType.toUpperCase()}`;
    }
    if (ui.btnEventAdd) {
      if (!isPanActive && eventSubMode === 'add') ui.btnEventAdd.classList.add('active');
      else ui.btnEventAdd.classList.remove('active');
    }
    if (ui.btnEventMove) {
      if (!isPanActive && eventSubMode === 'move') ui.btnEventMove.classList.add('active');
      else ui.btnEventMove.classList.remove('active');
    }
    if (ui.btnEventEdit) {
      if (!isPanActive && eventSubMode === 'edit') ui.btnEventEdit.classList.add('active');
      else ui.btnEventEdit.classList.remove('active');
      ui.btnEventEdit.disabled = false;
    }
    if (ui.btnEventDelete) {
      if (!isPanActive && eventSubMode === 'delete') ui.btnEventDelete.classList.add('active');
      else ui.btnEventDelete.classList.remove('active');
      ui.btnEventDelete.disabled = false;
    }

    // Append is only enabled when we have an Event selected (non-doodad)
    if (ui.btnAppend) ui.btnAppend.disabled = !isEventNode;
  }

  // Update Select middle controls
  if (toolMode === 'select') {
    if (ui.btnSelectDelete) {
      ui.btnSelectDelete.disabled = !hasSelection;
    }
  }

  // Add CSS classes for active editing states
  DOM.viewport.classList.remove(
      'edit-mode-active', 'edit-mode-island', 'edit-mode-doodad',
      'edit-mode-event', 'edit-mode-select', 'cur-layer-active'
  );
  if (toolMode === 'island') {
    DOM.viewport.classList.add('edit-mode-island');
  } else if (toolMode === 'doodad') {
    DOM.viewport.classList.add('edit-mode-doodad');
  } else if (toolMode === 'event') {
    DOM.viewport.classList.add('edit-mode-event');
  } else if (toolMode === 'select') {
    DOM.viewport.classList.add('edit-mode-select');
  }
  if (!isPanActive) {
    DOM.viewport.classList.add('edit-mode-active');
  }
  if (isCurLayerActive) {
    DOM.viewport.classList.add('cur-layer-active');
  }
  applyDrawLayerFilter();
}
