import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSnapshot, ImportSummary, MeleeBridge, PracticeHistoryEntry, ReplayCard } from '../shared/api';
import type { SessionView } from '../core/session';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import './styles.css';

declare global {
  interface Window { melee: MeleeBridge }
}

type Page = 'browse' | 'history' | 'setup' | 'session';
type AvailabilityFilter = 'all' | 'ready' | 'downloadable' | 'missing';

function formatStorage(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('browse');
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [session, setSession] = useState<SessionView>({ phase: 'idle', controls: [] });
  const [search, setSearch] = useState('');
  const [availability, setAvailability] = useState<AvailabilityFilter>('all');
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [opening, setOpening] = useState('all');
  const [player, setPlayer] = useState('all');
  const [event, setEvent] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [acquisitionPhase, setAcquisitionPhase] = useState<'preparing' | 'downloading' | 'verifying' | 'ready' | null>(null);
  const [notice, setNotice] = useState('');

  async function refresh(): Promise<void> {
    const next = await window.melee.snapshot();
    setSnapshot(next);
    setSession(next.session);
    if (next.session.phase !== 'idle') setPage((current) => current === 'setup' ? current : 'session');
  }

  useEffect(() => {
    refresh().catch(() => setNotice('The library could not load.'));
    const unsubscribeAcquisition = window.melee.onAcquisitionPhase((phase) => setAcquisitionPhase(phase));
    const unsubscribeSession = window.melee.onSessionChanged((view) => {
      setSession(view);
      if (view.phase !== 'idle') setPage((current) => current === 'setup' ? current : 'session');
      refresh().catch(() => setNotice('The library could not refresh.'));
    });
    return () => { unsubscribeAcquisition(); unsubscribeSession(); };
  }, []);

  useEffect(() => {
    if (session.phase !== 'intermission-countdown') return;
    const interval = window.setInterval(() => {
      window.melee.snapshot().then((next) => {
        setSession(next.session);
        if (next.session.phase !== 'intermission-countdown') setSnapshot(next);
      }).catch(() => setNotice('The practice session could not refresh.'));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [session.phase]);

  const cards = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (snapshot?.cards || []).filter((card) => {
      if (availability !== 'all' && card.availability !== availability) return false;
      if (kind !== 'all' && card.kind !== kind) return false;
      if (status !== 'all' && card.practiceStatus !== status) return false;
      if (opening !== 'all' && card.openingA !== opening && card.openingB !== opening) return false;
      if (player !== 'all' && card.playerA !== player && card.playerB !== player) return false;
      if (event !== 'all' && (card.event || '__unknown__') !== event) return false;
      return !query || [card.playerA, card.playerB, card.openingA, card.openingB, card.event || '']
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [snapshot, search, availability, kind, status, opening, player, event]);
  const openingOptions = useMemo(() => [...new Set((snapshot?.cards || []).flatMap((card) => [card.openingA, card.openingB]))].sort(), [snapshot]);
  const playerOptions = useMemo(() => [...new Set((snapshot?.cards || []).flatMap((card) => [card.playerA, card.playerB]))].sort(), [snapshot]);
  const eventOptions = useMemo(() => [...new Set((snapshot?.cards || []).map((card) => card.event || '__unknown__'))].sort(), [snapshot]);
  const selected = cards.find((card) => card.id === selectedId) || null;
  const availableCount = snapshot?.cards.filter((card) => card.availability === 'ready').length || 0;

  async function importReplays(kind: 'files' | 'folder' | 'package'): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      const result: ImportSummary = kind === 'files' ? await window.melee.importFiles()
        : kind === 'folder' ? await window.melee.importFolder() : await window.melee.importReporterPackage();
      await refresh();
      if (!result.cancelled) {
        const parts = [`${result.imported} added`];
        if (result.duplicates) parts.push(`${result.duplicates} already in library`);
        if (result.rejected) parts.push(`${result.rejected} unsupported or incomplete`);
        setNotice(parts.join(' · '));
      }
    } catch {
      setNotice('Import failed. Check the selected files and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function choosePath(kind: 'runtime' | 'image'): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      if (kind === 'runtime') await window.melee.choosePlaybackDolphin();
      else await window.melee.chooseGameImage();
      await refresh();
    } catch {
      setNotice(kind === 'runtime' ? 'Select an official Slippi Playback Dolphin executable.' : 'Select a supported Melee game image.');
    } finally {
      setBusy(false);
    }
  }

  async function recheckSetup(): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      await window.melee.recheckSetup();
      await refresh();
      setNotice('Setup checked.');
    } catch {
      setNotice('Setup could not be checked. Check the selected files and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function acquire(itemId: string): Promise<void> {
    setNotice('');
    setAcquisitionPhase('preparing');
    try {
      await window.melee.acquireCatalogItem(itemId);
      await refresh();
      setNotice('Replay ready.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Replay preparation failed.');
    } finally {
      setAcquisitionPhase(null);
    }
  }

  async function removeIndexedReplay(replayId: string): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      await window.melee.removeIndexedReplay(replayId);
      setSelectedId(null);
      await refresh();
      setNotice('Removed from the library index. The replay file and practice history were kept.');
    } catch {
      setNotice('Could not remove the replay from the library index.');
    } finally {
      setBusy(false);
    }
  }

  async function clearCache(): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      const freed = await window.melee.clearDownloadCache();
      await refresh();
      setNotice(`Download cache cleared. ${formatStorage(freed)} recovered. Replay files and practice history were kept.`);
    } catch {
      setNotice('Could not clear the download cache.');
    } finally {
      setBusy(false);
    }
  }

  async function locateReplay(replayId: string, method: 'file' | 'folder'): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      const found = method === 'file' ? await window.melee.relinkReplay(replayId)
        : await window.melee.findReplayInFolder(replayId);
      if (found) {
        await refresh();
        setNotice('Original replay found and ready.');
      }
    } catch {
      setNotice('The original replay could not be found.');
    } finally {
      setBusy(false);
    }
  }

  async function startPractice(itemId: string): Promise<void> {
    setSessionBusy(true);
    setNotice('');
    try {
      const next = await window.melee.startPractice(itemId);
      setSession(next);
      setPage('session');
      await refresh();
    } catch {
      setNotice('Practice could not start. Check Setup and try again.');
    } finally {
      setSessionBusy(false);
    }
  }

  async function sessionCommand(command: 'stop' | 'hold' | 'next' | 'leave' | 'practice-again'): Promise<void> {
    setSessionBusy(true);
    setNotice('');
    try {
      const next = await window.melee.sessionCommand(command);
      setSession(next);
      if (command === 'leave' && next.phase === 'idle') setPage('browse');
      await refresh();
    } catch {
      setNotice('The session command could not finish. Please try again.');
    } finally {
      setSessionBusy(false);
    }
  }

  function selectRandom(): void {
    const unseen = cards.filter((card) => card.availability !== 'missing' && card.practiceStatus === 'unseen');
    if (unseen.length === 0) {
      setNotice('No unseen replays match these filters.');
      return;
    }
    setNotice('');
    setSelectedId(unseen[Math.floor(Math.random() * unseen.length)].id);
  }

  function openHistoryItem(itemId: string): void {
    setSearch('');
    setAvailability('all');
    setKind('all');
    setStatus('all');
    setOpening('all');
    setPlayer('all');
    setEvent('all');
    setSelectedId(itemId);
    setPage('browse');
    setNotice('');
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-symbol" aria-hidden="true"><span/><span/><span/></div><strong>Melee<br/>Replay</strong></div>
      <nav aria-label="Main navigation">
        <button className={page === 'browse' ? 'nav-link active' : 'nav-link'} onClick={() => setPage('browse')} aria-current={page === 'browse' ? 'page' : undefined}>Browse</button>
        <button className={page === 'history' ? 'nav-link active' : 'nav-link'} onClick={() => setPage('history')} aria-current={page === 'history' ? 'page' : undefined}>History</button>
        {session.phase !== 'idle' && <button className={page === 'session' ? 'nav-link active' : 'nav-link'} onClick={() => setPage('session')} aria-current={page === 'session' ? 'page' : undefined}>Practice</button>}
        <button className={page === 'setup' ? 'nav-link active' : 'nav-link'} onClick={() => setPage('setup')} aria-current={page === 'setup' ? 'page' : undefined}>Setup</button>
      </nav>
      <div className="sidebar-bottom"><span className="status-dot"/>{availableCount} local replay{availableCount === 1 ? '' : 's'}</div>
    </aside>

    <main className="main-content">
      {page === 'session' ? <PracticeSession view={session} busy={sessionBusy} onCommand={sessionCommand} onSetup={() => setPage('setup')} /> : page === 'history' ? <>
        <header className="page-head"><div><h1>Practice history</h1><p>Your completed and interrupted sessions, newest first.</p></div></header>
        <section className="history-list" aria-label="Practice history">
          {!snapshot && <p className="empty">Loading practice history…</p>}
          {snapshot && snapshot.history.length === 0 && <div className="empty-panel"><h2>No practice sessions yet</h2><p>Start with a replay from the library. Your sessions will appear here.</p><button className="button primary" onClick={() => setPage('browse')}>Browse replays</button></div>}
          {snapshot?.history.map((entry) => {
            const card = snapshot.cards.find((item) => item.id === entry.itemId);
            const canRetry = card?.availability === 'ready' && session.phase === 'idle';
            return <HistoryRow key={entry.attemptId} entry={entry} canRetry={canRetry} available={!!card} busy={sessionBusy}
              onRetry={() => startPractice(entry.itemId)} onOpen={() => openHistoryItem(entry.itemId)} />;
          })}
        </section>
      </> : page === 'browse' ? <>
        <header className="page-head">
          <div><h1>Browse replays</h1><p>Select a game without seeing its result.</p><p className="page-guidance">Replay Reporter packages import as standalone games unless independently verified in the catalog.</p></div>
          <div className="head-actions">
            <button className="button secondary" disabled={busy} onClick={() => importReplays('folder')}>Import folder</button>
            <button className="button secondary" disabled={busy} onClick={() => importReplays('package')}>Import Reporter package</button>
            <button className="button primary" disabled={busy} onClick={() => importReplays('files')}>Import files</button>
          </div>
        </header>
        <section className="toolbar" aria-label="Replay filters">
          <label className="search-field"><span className="sr-only">Search players, characters, or event</span><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search players or opening matchup" /></label>
          <button className="button secondary" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>Filters</button>
          <button className="button random" onClick={selectRandom}>Random unseen <span aria-hidden="true">↗</span></button>
        </section>
        {showFilters && <section className="filter-panel" aria-label="Browse filters">
          <label>Kind<select value={kind} onChange={(change) => setKind(change.target.value)}><option value="all">All kinds</option><option value="standalone">Standalone</option><option value="set">Verified sets</option></select></label>
          <label>Availability<select value={availability} onChange={(change) => setAvailability(change.target.value as AvailabilityFilter)}><option value="all">All</option><option value="ready">Ready</option><option value="downloadable">Online</option><option value="missing">Missing</option></select></label>
          <label>Practice<select value={status} onChange={(change) => setStatus(change.target.value)}><option value="all">All states</option><option value="unseen">Unseen</option><option value="incomplete">Incomplete</option><option value="completed">Completed</option></select></label>
          <label>Opening character<select value={opening} onChange={(change) => setOpening(change.target.value)}><option value="all">Any character</option>{openingOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>Player<select value={player} onChange={(change) => setPlayer(change.target.value)}><option value="all">Any player</option>{playerOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>Event<select value={event} onChange={(change) => setEvent(change.target.value)}><option value="all">Any event</option>{eventOptions.map((value) => <option key={value} value={value}>{value === '__unknown__' ? 'Unknown' : value}</option>)}</select></label>
        </section>}
        <div className="content-grid">
          <section className="replay-list" aria-label="Replays">
            <div className="list-heading"><span>Practice items</span><span>{cards.length}</span></div>
            {!snapshot && <p className="empty">Loading library…</p>}
            {snapshot && cards.length === 0 && <div className="empty-panel"><h2>{snapshot.cards.length ? 'No matches' : 'Your library is empty'}</h2><p>{snapshot.cards.length ? 'Change the search or availability filter.' : 'Import Slippi replay files or a folder to begin.'}</p></div>}
            {cards.map((card) => <ReplayRow key={card.id} card={card} selected={selectedId === card.id} onSelect={() => { setSelectedId(card.id); setNotice(''); }} />)}
          </section>
          <aside className="detail-panel" aria-label="Selected replay">
            {selected ? <>
              <div className="detail-top"><span className="eyebrow">{selected.kind === 'set' ? 'Verified set' : 'Standalone game'}</span><span className={`availability ${selected.availability}`}>{selected.availability === 'ready' ? 'Ready' : selected.availability === 'downloadable' ? 'Downloadable' : 'Missing'}</span></div>
              <div className="matchup"><strong>{selected.playerA}</strong><span>vs</span><strong>{selected.playerB}</strong></div>
              <div className="detail-rule"/>
              <div className="detail-field"><span>Opening matchup</span><strong>{selected.openingA} / {selected.openingB}</strong></div>
              <div className="detail-field"><span>Event</span><strong>{selected.event || 'Unknown'}</strong></div>
              <div className="detail-field"><span>Recorded</span><strong>{selected.playedAt ? new Date(selected.playedAt).toLocaleDateString() : 'Unknown'}</strong></div>
              <div className="detail-field"><span>Practice</span><strong className="capitalize">{selected.practiceStatus}</strong></div>
              <div className="detail-bottom">
                {selected.availability === 'downloadable' ? <>
                  <button className="button primary wide" disabled={!!acquisitionPhase} onClick={() => acquire(selected.id)}>{acquisitionPhase ? `${acquisitionPhase[0].toUpperCase()}${acquisitionPhase.slice(1)}…` : selected.kind === 'set' ? 'Download set' : 'Download replay'}</button>
                  {acquisitionPhase && <button className="text-button" onClick={() => window.melee.cancelAcquisition()}>Cancel download</button>}
                </> : <button className="button primary wide" disabled={selected.availability !== 'ready' || sessionBusy || session.phase !== 'idle'} onClick={() => startPractice(selected.id)}>{session.phase !== 'idle' ? 'Practice session in progress' : selected.availability === 'ready' ? 'Start practice' : 'Replay unavailable'}</button>}
                {selected.source === 'catalog' && selected.availability === 'ready' &&
                  <button className="text-button" disabled={!!acquisitionPhase || session.phase !== 'idle'} onClick={() => acquire(selected.id)}>Repair download</button>}
                {selected.source === 'local' && <div className="local-actions">
                  {selected.availability === 'missing' && <>
                    <p>The original replay is missing or changed. Choose the same file or search a folder. Its practice history stays linked to the original replay.</p>
                    <div className="local-action-buttons">
                      <button className="button secondary" disabled={busy || sessionBusy} onClick={() => locateReplay(selected.id, 'file')}>Choose replay file</button>
                      <button className="button secondary" disabled={busy || sessionBusy} onClick={() => locateReplay(selected.id, 'folder')}>Search folder</button>
                    </div>
                  </>}
                  <button className="text-button" disabled={busy || sessionBusy || session.phase !== 'idle'} onClick={() => removeIndexedReplay(selected.id)}>Remove from library index</button>
                  <p>Removing this listing keeps the replay file and practice history.</p>
                </div>}
              </div>
            </> : <div className="detail-empty"><div className="detail-mark" aria-hidden="true">◇</div><h2>Select a replay</h2><p>Player names and opening matchup are available before playback.</p></div>}
          </aside>
        </div>
      </> : <>
        <header className="page-head"><div><h1>Setup</h1><p>Use your installed Slippi Playback Dolphin and Melee game image.</p></div></header>
        <section className="setup-grid">
          <div className="setup-card"><span className="setup-number">01</span><h2>Playback Dolphin</h2><p>{snapshot?.setup.playbackDolphin || 'No executable selected'}</p><button className="button secondary" disabled={busy} onClick={() => choosePath('runtime')}>Choose executable</button></div>
          <div className="setup-card"><span className="setup-number">02</span><h2>Melee game image</h2><p>{snapshot?.setup.gameImage || 'No image selected'}</p><button className="button secondary" disabled={busy} onClick={() => choosePath('image')}>Choose image</button></div>
        </section>
        <div className="setup-actions"><button className="button primary" disabled={busy} onClick={recheckSetup}>Recheck setup</button><button className="text-button" onClick={() => window.melee.openSlippiSetup().catch(() => setNotice('Could not open Slippi setup.'))}>Official Slippi setup ↗</button></div>
        <section className="managed-storage" aria-label="Managed storage">
          <div><h2>Managed storage</h2><p>App-owned downloads and replay copies: {formatStorage(snapshot?.managedStorage.totalBytes || 0)}. Download cache available to clear: {formatStorage(snapshot?.managedStorage.downloadCacheBytes || 0)}.</p><p>Clearing cached archives keeps playable replays, your original files, and practice history. An archive downloads again if needed later.</p></div>
          <button className="button secondary" disabled={busy || !!acquisitionPhase || session.phase !== 'idle' || !snapshot?.managedStorage.downloadCacheBytes} onClick={clearCache}>Clear download cache</button>
        </section>
        <section className="third-party-note" aria-label="Third-party software">
          <h2>Third-party software</h2>
          <p>Melee Replay uses Slippi JS under LGPL-3.0-or-later. The app package includes its license and other dependency notices.</p>
          <button className="text-button" onClick={() => window.melee.openThirdPartyNotices().catch(() => setNotice('Could not open third-party notices.'))}>View notices and licenses ↗</button>
        </section>
      </>}
      {notice && <div className="notice" role="status">{notice}</div>}
    </main>
  </div>;
}

function ReplayRow({ card, selected, onSelect }: { card: ReplayCard; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const anonymous = card.playerA.startsWith('Unknown Player') && card.playerB.startsWith('Unknown Player');
  return <button className={selected ? 'replay-row selected' : 'replay-row'} onClick={onSelect} aria-pressed={selected}>
    <span className="row-index" aria-hidden="true">◆</span>
    <span className="row-main"><strong>{anonymous ? card.openingA : card.playerA} <span>vs</span> {anonymous ? card.openingB : card.playerB}</strong><small>{anonymous ? 'Players unknown' : `${card.openingA} / ${card.openingB}`}{card.event ? ` · ${card.event}` : ''}</small></span>
    <span className={`row-status ${card.availability}`}>{card.availability === 'ready' ? 'Ready' : card.availability === 'downloadable' ? 'Online' : 'Missing'}</span>
    <span className="row-arrow" aria-hidden="true">↗</span>
  </button>;
}

function HistoryRow({ entry, canRetry, available, busy, onRetry, onOpen }: {
  entry: PracticeHistoryEntry;
  canRetry: boolean;
  available: boolean;
  busy: boolean;
  onRetry: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  const status = entry.status === 'completed' ? 'Completed' : entry.status === 'interrupted' ? 'Stopped' : 'Could not finish';
  const timestamp = entry.startedAt || entry.requestedAt;
  return <article className="history-row">
    <div className="history-details">
      <span className={`history-status ${entry.status}`}>{status}</span>
      <h2>{entry.label}</h2>
      <p>{entry.event ? `${entry.event} · ` : ''}{entry.startedAt ? 'Played' : 'Requested'} {new Date(timestamp).toLocaleString()}</p>
    </div>
    {available && <button className={canRetry ? 'button primary' : 'button secondary'} disabled={busy}
      onClick={canRetry ? onRetry : onOpen}>{canRetry ? entry.status === 'completed' ? 'Practice again' : 'Retry practice' : 'View in library'}</button>}
  </article>;
}

const phaseLabels: Record<SessionView['phase'], string> = {
  idle: 'Ready',
  preparing: 'Preparing replay',
  starting: 'Opening playback',
  playing: 'Now playing',
  'intermission-countdown': 'Between games',
  'intermission-held': 'On hold',
  completed: 'Practice complete',
  interrupted: 'Practice stopped',
  failed: 'Playback issue',
};

const failureMessages: Record<NonNullable<SessionView['failureReason']>, string> = {
  'preparation-failed': 'This replay could not be prepared. Try again from the library.',
  'playback-unavailable': 'Playback could not start. Check your Playback Dolphin and game image in Setup.',
  'connection-lost': 'The playback connection ended. You can return to the library and try again.',
  'asset-unavailable': 'A required replay is unavailable. Reacquire the item from the library and try again.',
  'unsupported-playback': 'This Playback Dolphin could not run the session. Check Setup for a supported version.',
};

function PracticeSession({ view, busy, onCommand, onSetup }: {
  view: SessionView;
  busy: boolean;
  onCommand: (command: 'stop' | 'hold' | 'next' | 'leave' | 'practice-again') => void;
  onSetup: () => void;
}): React.JSX.Element {
  const entrants = view.context?.entrants;
  const active = view.phase === 'preparing' || view.phase === 'starting' || view.phase === 'playing';
  return <>
    <header className="page-head practice-head">
      <div><span className="eyebrow">Practice</span><h1>{phaseLabels[view.phase]}</h1><p>{view.context?.event || 'Melee Replay'}{view.context?.round ? ` · ${view.context.round}` : ''}</p></div>
      <span className={`practice-phase ${active ? 'active' : ''}`}>{phaseLabels[view.phase]}</span>
    </header>
    <section className="practice-panel" aria-label="Practice session" aria-live="polite">
      {entrants && <div className="practice-matchup"><strong>{entrants[0]}</strong><span>vs</span><strong>{entrants[1]}</strong></div>}
      {view.context?.date && <p className="practice-date">{new Date(view.context.date).toLocaleDateString()}</p>}
      {view.observedScore && entrants && <div className="practice-score" aria-label="Observed score"><span>{entrants[0]} <strong>{view.observedScore[0]}</strong></span><span>{entrants[1]} <strong>{view.observedScore[1]}</strong></span></div>}
      {view.phase === 'playing' && view.currentGame && <div className="practice-now"><span className="eyebrow">On screen now</span><h2>Game {view.currentGame.number}</h2><p>{view.currentGame.characters.filter(Boolean).join(' / ')}{view.currentGame.stage ? ` · ${view.currentGame.stage}` : ''}</p></div>}
      {view.phase === 'preparing' && <p className="practice-message">Checking the replay and playback setup…</p>}
      {view.phase === 'starting' && <p className="practice-message">Playback is opening in its own window.</p>}
      {view.phase === 'playing' && <p className="practice-message">Watch the gameplay in the Playback Dolphin window.</p>}
      {view.phase === 'intermission-countdown' && <div className="practice-intermission"><span className="eyebrow">Intermission</span><strong>{view.remainingSeconds ?? 0}</strong><p>seconds until the next game</p></div>}
      {view.phase === 'intermission-held' && <div className="practice-intermission"><span className="eyebrow">Intermission</span><h2>Take your time.</h2><p>Continue when you are ready.</p></div>}
      {view.phase === 'completed' && <p className="practice-message">Session finished. Choose Practice again or return to the library.</p>}
      {view.phase === 'interrupted' && <p className="practice-message">Your progress was saved. Return to the library when you are ready.</p>}
      {view.phase === 'failed' && <p className="practice-message">{view.failureReason ? failureMessages[view.failureReason] : 'Playback stopped. Return to the library and try again.'}</p>}
      {view.phase === 'failed' && (view.failureReason === 'playback-unavailable' || view.failureReason === 'unsupported-playback') && <button className="text-button" onClick={onSetup}>Open Setup</button>}
      <div className="practice-controls">
        {view.controls.includes('next') && <button className="button primary" disabled={busy} onClick={() => onCommand('next')}>Next game</button>}
        {view.controls.includes('hold') && <button className="button secondary" disabled={busy} onClick={() => onCommand('hold')}>Hold</button>}
        {view.controls.includes('stop') && <button className="button secondary" disabled={busy} onClick={() => onCommand('stop')}>Stop session</button>}
        {view.controls.includes('practice-again') && <button className="button primary" disabled={busy} onClick={() => onCommand('practice-again')}>Practice again</button>}
        {view.controls.includes('leave') && <button className="button secondary" disabled={busy} onClick={() => onCommand('leave')}>Return to library</button>}
      </div>
    </section>
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
