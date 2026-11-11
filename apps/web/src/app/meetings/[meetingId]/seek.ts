/**
 * Lets any part of the meeting page (e.g. an insight's evidence link) ask the
 * recording player to jump to a moment, without the components sharing state.
 */
export const SEEK_EVENT = "voiceover:seek";

export interface SeekDetail {
  recordingTrackId: string;
  ms: number;
}

export function requestSeek(detail: SeekDetail): void {
  window.dispatchEvent(new CustomEvent<SeekDetail>(SEEK_EVENT, { detail }));
}
