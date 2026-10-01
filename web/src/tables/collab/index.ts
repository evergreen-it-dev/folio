/**
 * Round 26 (DATA TABLES) — public surface of the table collab binding
 * (COLLAB-TABLES' client zone). TABLES-UI / SHELL-TABLES wire the table page
 * through here:
 *
 *   const session = useTableCollab(pageId, collabUrl, shareParams);
 *   const { doc, seeded, error } = useTableDoc(session?.doc ?? null);
 *   const onPatch = useTablePatchSink(session?.doc ?? null);
 *   const { undo, redo, canUndo, canRedo } = useTableUndo(session?.undoManager ?? null);
 *   const presence = useCellPresence(session?.provider.awareness ?? null);
 *   const setCell = useLocalCell(session?.provider.awareness ?? null);
 *
 * `seeded` is false until the server's awaited seed lands — render a skeleton
 * then, never an empty table: "an empty table" is indistinguishable on screen
 * from "your data is gone", and it's the exact moment at which it is NOT.
 */
export {
  TABLE_LOCAL_ORIGIN,
  applyTablePatch,
  applyTablePatches,
  buildColumnMap,
  buildRowMap,
  buildViewMap,
  isTableYDocSeeded,
  pruneDanglingColumnRefs,
  seedTableYDoc,
  setYText,
  tableDocFromYDoc,
  tableRoots,
  undoScope,
  type TableRoots,
} from './ydoc';

export {
  tableCellText,
  useTableCollab,
  useTableConnectionStatus,
  useTableDoc,
  useTablePatchSink,
  useTableUndo,
  type TableCollabSession,
  type TableConnectionStatus,
  type TableDocState,
  type TableUndoControls,
} from './useTableCollab';

export {
  cellKey,
  peersByCell,
  useCellPresence,
  useLocalCell,
  usePresentPeers,
  type CellCursor,
  type CellPeer,
} from './awareness';
