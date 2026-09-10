import { State } from '../core/state';
import { DOM } from '../app/dom';
import { EditorState } from './EditorState';
import { updateToolbarState } from '../ui/toolbar';
import { updateInspector } from '../ui/sidebar';

export function clearSelection(): void {
  if (EditorState.selectedPieceRef) {
    document.querySelectorAll('.selected-piece').forEach(el => {
      el.classList.remove('selected-piece');
    });
    EditorState.selectedPieceRef = null;
    updateToolbarState();
    updateInspector();
  }
}

export function selectPiece(pieceRef: any): void {
  clearSelection();
  EditorState.selectedPieceRef = pieceRef;
  if (pieceRef) {
    const node = pieceRef.piece || pieceRef.node;
    if (node) {
      // Highlight ALL elements that share this node/piece
      State.data.pieces.forEach(p => {
        if (p.piece === node) {
          p.element.classList.add('selected-piece');
        }
      });
      State.data.eventPieces.forEach(ep => {
        if (ep.node === node) {
          ep.element.classList.add('selected-piece');
        }
      });

      const x = Math.round(node.m_position?.x || 0);
      const y = Math.round(node.m_position?.y || 0);
      const name = node.m_name || node.m_eventType || 'Unnamed Piece';
      DOM.uiElements.metaBar.textContent = `SELECTED: ${name} | X: ${x}, Y: ${y} | IMG: ${node.m_imageID ?? 'N/A'}`;
    }
  }
  updateToolbarState();
  updateInspector();
}
