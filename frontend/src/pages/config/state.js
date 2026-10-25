/** State belongs to one configuration page, including its unsaved draft. */
export function createPageState(editingRoomId = null) {
  return {
    catalog: null,
    state: null,
    cardConfiguration: "default",
    customState: null,
    activeKind: "village",
    searchText: "",
    trimNotice: "",
    activeExtraKind: "guardian",
    extraSearchText: "",
    roomEditor: null,
    editingRoomId,
  };
}
