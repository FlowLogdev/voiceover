export interface TimedLanguage {
  startMs: number;
  endMs: number;
  languageCode: string;
}

/**
 * Collapses transcript segments into contiguous language runs (for the
 * meeting's language timeline), sorted by start. Adjacent or overlapping
 * segments in the same language merge; a gap of at most `maxGapMs` between
 * same-language segments is bridged, so ordinary pauses don't fragment a run.
 */
export function mergeLanguageSegments(segments: TimedLanguage[], maxGapMs = 5_000): TimedLanguage[] {
  const runs: TimedLanguage[] = [];
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const last = runs[runs.length - 1];
    if (last && last.languageCode === segment.languageCode && segment.startMs - last.endMs <= maxGapMs) {
      last.endMs = Math.max(last.endMs, segment.endMs);
    } else {
      runs.push({ ...segment });
    }
  }
  return runs;
}
