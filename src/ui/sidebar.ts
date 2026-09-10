import { State } from '../core/state';
import { DOM } from '../app/dom';
import { EditorState } from '../editor/EditorState';
import { getSelectedNode, isDoodadRef, isMapPieceRef } from '../editor/types';
import { openEventEditorModal } from '../editor/EventPropertyEditor';

export function updateInspector(): void {
  const inspector = document.getElementById('sidebar-left-inspector');
  const details = document.getElementById('inspector-details');
  if (!inspector || !details) return;

  const selectedPieceRef = EditorState.selectedPieceRef;
  if (!selectedPieceRef) {
    inspector.style.display = 'none';
    return;
  }

  inspector.style.display = 'block';
  const node = getSelectedNode(selectedPieceRef);
  if (!node) {
    inspector.style.display = 'none';
    return;
  }

  const name = node.m_name || node.m_eventType || 'Unnamed Piece';
  const type = isMapPieceRef(selectedPieceRef) ? 'Island Piece' :
      isDoodadRef(selectedPieceRef) ? 'Doodad' : 'Event Node';
  const posX = Math.round(node.m_position?.x || 0);
  const posY = Math.round(node.m_position?.y || 0);
  const imageID = node.m_imageID !== undefined ? node.m_imageID : 'N/A';
  const drawLayer = node.m_drawLayer !== undefined ? node.m_drawLayer : 0;
  const parallaxLayer = node.m_parallaxLayer !== undefined ? node.m_parallaxLayer : 0;

  let extraDetails = '';
  if (type === 'Event Node') {
    extraDetails = `
      <div style="font-size: 11px; color: #71717a; margin-top: 4px;">
        <strong>Event Type:</strong> <span style="color: #e4e4e7;">${node.m_eventType || 'level'}</span>
      </div>
    `;
  }

  details.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="font-size: 13px; font-weight: bold; color: var(--accent-gold); border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px; word-break: break-all;">
        ${name}
      </div>
      <div style="font-size: 11px; color: #71717a;">
        <strong>Category:</strong> <span style="color: #e4e4e7;">${type}</span>
      </div>
      <div style="font-size: 11px; color: #71717a;">
        <strong>Coordinates:</strong> <span style="color: #e4e4e7;">X: ${posX}, Y: ${posY}</span>
      </div>
      <div style="font-size: 11px; color: #71717a;">
        <strong>Image ID:</strong> <span style="color: #e4e4e7;">${imageID}</span>
      </div>
      <div style="font-size: 11px; color: #71717a;">
        <strong>Draw Layer:</strong> <span style="color: #e4e4e7;">${drawLayer}</span>
      </div>
      <div style="font-size: 11px; color: #71717a;">
        <strong>Parallax Layer:</strong> <span style="color: #e4e4e7;">${parallaxLayer}</span>
      </div>
      ${extraDetails}
      <div style="border-top: 1px solid rgba(255,255,255,0.05); margin-top: 8px; padding-top: 8px; display: flex; flex-direction: column; gap: 6px;">
        <button id="inspector-btn-delete" class="toolbar-btn" style="width: 100%; text-align: center; color: #f87171; background: rgba(248,113,113,0.05); border: 1px solid rgba(248,113,113,0.15); cursor: pointer; border-radius: 4px; padding: 6px 0; font-size: 11px;">❌ Delete Object</button>
        ${type === 'Event Node' ? '<button id="inspector-btn-edit" class="toolbar-btn" style="width: 100%; text-align: center; color: #fbbf24; background: rgba(251,191,36,0.05); border: 1px solid rgba(251,191,36,0.15); cursor: pointer; border-radius: 4px; padding: 6px 0; font-size: 11px;">⚙️ Edit Attributes</button>' : ''}
      </div>
    </div>
  `;

  const deleteBtn = document.getElementById('inspector-btn-delete');
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      if (type === 'Event Node') {
        DOM.uiElements.btnEventDelete.click();
      } else {
        DOM.uiElements.btnDelete.click();
      }
    };
  }

  const editBtn = document.getElementById('inspector-btn-edit');
  if (editBtn) {
    editBtn.onclick = () => {
      if (type === 'Event Node') {
        openEventEditorModal(node);
      }
    };
  }
}

// Populates the world <select> from the worldmap.json files that were auto-discovered
// under packages/worlds/{worldName}/worldmap.json inside the uploaded root folder.
export function populateWorldSelector(): void {
  const select = DOM.uiElements.selectWorld;
  if (!select) return;

  const previousValue = select.value;
  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = State.data.availableWorlds.length
      ? `-- Select World (${State.data.availableWorlds.length}) --`
      : '-- No worlds found --';
  select.appendChild(placeholder);

  State.data.availableWorlds.forEach(world => {
    const opt = document.createElement('option');
    opt.value = world;
    opt.textContent = world.toUpperCase();
    select.appendChild(opt);
  });

  select.disabled = State.data.availableWorlds.length === 0;

  if (State.data.availableWorlds.includes(previousValue)) {
    select.value = previousValue;
  } else {
    select.value = '';
  }
}
