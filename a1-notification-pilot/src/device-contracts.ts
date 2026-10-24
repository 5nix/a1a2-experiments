export interface GlassesRequest {
  request_id: string; session_id: string; participant_id: string; stage_id: string; message_id: string;
  text: string; duration_ms: number; display_mode?: string; device_id?: string;
  image_sha256?: string; image_width_px?: number;
}
export interface GlassesReceipt { request_id: string; device_id?: string; source: 'device'; status: 'accepted' | 'failed' | 'unacknowledged'; t_send: string; t_ack: string | null; t_display: null; t_hide: null; display_time_source: string; error: string | null; evidence?: unknown }
export interface GlassesEvent { event_id: string; request_id: string; device_id: string; kind: string; device_wall_ms: number; device_monotonic_ms: number; clock_id: string; error: string | null }
export interface GlassesStatus { source: 'device'; connected: boolean; ready?: boolean; busy?: boolean; device_id?: string; error?: string | null; protocol?: string; independent_duration?: boolean; persistent_deduplication?: boolean; display_evidence?: string; device_info?: Record<string, string>; image_protocol?: boolean }
export interface ImageAdapter {
  clockSample?(): Promise<{ device_monotonic_ms: number; clock_id: string }>;
  getStatus(): GlassesStatus;
  probe(): Promise<void>; reconnect(): Promise<void>; close(): Promise<void>;
  prepareImage(path: string, sha: string, packageName: string): Promise<void>;
  sendImage(request: GlassesRequest): Promise<GlassesReceipt>;
  pollEvents(receive: (event: GlassesEvent) => void): Promise<void>;
}
export interface GlassesAdapter extends ImageAdapter { send(request: GlassesRequest): Promise<GlassesReceipt> }
