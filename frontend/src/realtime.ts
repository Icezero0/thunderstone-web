import type {ApiClient} from './api.js';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export class RoomConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;

  constructor(private api: ApiClient, private changed: () => void,
              private status: (status: ConnectionStatus) => void) {}

  async connect(): Promise<void> {
    if (this.stopped) return;
    this.status('connecting');
    try {
      if (!await this.api.restore() || this.stopped) return;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      this.socket = socket;
      socket.onopen = () => socket.send(JSON.stringify({type: 'auth', payload: {token: this.api.accessToken}}));
      socket.onmessage = event => {
        let message;
        try {message = JSON.parse(event.data);} catch {return;}
        if (message.type === 'ack') {
          this.attempt = 0;
          this.status('online');
          this.changed(); // Refresh after reconnect to recover missed invalidations.
          this.heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'heartbeat'}));
          }, 25_000);
        } else if (message.type === 'room_changed') this.changed();
      };
      socket.onclose = () => {this.clearHeartbeat(); this.schedule();};
      socket.onerror = () => socket.close();
    } catch {this.schedule();}
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.status('offline');
    this.retry = setTimeout(() => {void this.connect();}, Math.min(10_000, 1000 * 2 ** this.attempt++));
  }

  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.clearHeartbeat();
    this.socket?.close();
  }
}
