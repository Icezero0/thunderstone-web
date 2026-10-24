/** State belongs to one configuration page, including its unsaved draft. */
export function createPageState(editingRoomId = null) {
  return {
    catalog: null,
    state: null,
    activeKind: "village",
    searchText: "",
    trimNotice: "",
    activeExtraKind: "guardian",
    extraSearchText: "",
    setupResult: null,
    pendingSetupRequest: null,
    setupRunToken: 0,
    roomEditor: null,
    editingRoomId,
  };
}
