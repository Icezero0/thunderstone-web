/** Versioned server checkpoint, not the viewer-specific MatchView projection. */
export interface MatchExport {
  format: 'thunderstone-match';
  format_version: 1;
  exported_at: string;
  match: {id: string; version: number; room_id: string; host_user_id: number;
    history_cursor: number | null; history_epoch: number; created_at: string; updated_at: string};
  players: Array<{user_id: number; player_id: string; display_name: string}>;
  rules: {engine_version: string; effects_version: string};
  catalog_snapshot: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

export function downloadMatchFile(data: MatchExport): void {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], {type: 'application/json;charset=utf-8'});
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `thunderstone-match-${data.match.id}-v${data.match.version}.json`; link.hidden = true;
  document.body.append(link);
  try {link.click();}
  finally {
    link.remove();
    // Let the browser consume the object URL before releasing its backing data.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
