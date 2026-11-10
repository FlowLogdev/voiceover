/**
 * In-process enforcement point for stopping live recording immediately —
 * on user stop or consent revocation — rather than waiting for the client to
 * notice:
 *
 * - live browser-upload sockets register here and are closed by `stopTracks`;
 * - the meeting-bot audio sink drops frames for stopped tracks, so audio
 *   stops being stored even if the bot provider fails to remove the bot.
 *
 * The database is the source of truth (the upload socket re-checks session
 * status + consent on every connect); this only covers connections that are
 * already open. Single-process, like TranscriptBus — needs Redis pub/sub once
 * there is more than one API replica.
 */
export const UPLOAD_CLOSE_STOPPED = 4009;
export const UPLOAD_CLOSE_CONSENT = 4003;

/** Caps memory: stopped-track ids only matter while a provider might still be delivering frames. */
const MAX_REMEMBERED_STOPPED_TRACKS = 10_000;

type CloseFn = (code: number, reason: string) => void;

export class RecordingControl {
  private readonly uploads = new Map<string, Set<CloseFn>>();
  private readonly stopped = new Set<string>();

  registerUpload(recordingTrackId: string, close: CloseFn): () => void {
    let set = this.uploads.get(recordingTrackId);
    if (!set) {
      set = new Set();
      this.uploads.set(recordingTrackId, set);
    }
    set.add(close);
    return () => {
      const current = this.uploads.get(recordingTrackId);
      current?.delete(close);
      if (current?.size === 0) this.uploads.delete(recordingTrackId);
    };
  }

  stopTracks(recordingTrackIds: Iterable<string>, code: number, reason: string): void {
    for (const id of recordingTrackIds) {
      this.stopped.add(id);
      for (const close of this.uploads.get(id) ?? []) close(code, reason);
      this.uploads.delete(id);
    }
    while (this.stopped.size > MAX_REMEMBERED_STOPPED_TRACKS) {
      const oldest = this.stopped.values().next().value as string;
      this.stopped.delete(oldest);
    }
  }

  isStopped(recordingTrackId: string): boolean {
    return this.stopped.has(recordingTrackId);
  }

  liveUploadCount(recordingTrackId: string): number {
    return this.uploads.get(recordingTrackId)?.size ?? 0;
  }
}
