import { describe, expect, it } from 'vitest';
import { TerminalObservation } from './playback-dolphin';

function loaded(lastFrame: number): TerminalObservation {
  const evidence = new TerminalObservation(lastFrame);
  evidence.confirmPath();
  evidence.confirmExpectedFrame(lastFrame);
  evidence.confirmStart();
  return evidence;
}

describe('Playback terminal evidence', () => {
  it('requires a matched replay, an observed start, terminal frame and native end', () => {
    const evidence = loaded(1000);
    expect(evidence.shouldReportStart()).toBe(true);
    expect(evidence.shouldReportStart()).toBe(false);
    evidence.confirmFrame(999);
    evidence.confirmEnd();
    expect(evidence.complete).toBe(false);
    expect(evidence.endedWithoutTerminalFrame).toBe(true);
    evidence.confirmFrame(1000);
    expect(evidence.complete).toBe(true);
  });

  it('rejects an end from an earlier replay before this replay starts', () => {
    const evidence = new TerminalObservation(1000);
    evidence.confirmEnd();
    evidence.confirmStart();
    evidence.confirmPath();
    evidence.confirmExpectedFrame(1000);
    evidence.confirmStart();
    evidence.confirmFrame(1000);
    expect(evidence.complete).toBe(false);
  });

  it('never completes after a stop or mismatched terminal declaration', () => {
    const stopped = loaded(1000);
    stopped.confirmFrame(1000);
    stopped.invalidate();
    stopped.confirmEnd();
    expect(stopped.complete).toBe(false);

    const mismatched = new TerminalObservation(1000);
    mismatched.confirmPath();
    mismatched.confirmExpectedFrame(999);
    mismatched.confirmStart();
    mismatched.confirmFrame(1000);
    mismatched.confirmEnd();
    expect(mismatched.complete).toBe(false);
  });
});
