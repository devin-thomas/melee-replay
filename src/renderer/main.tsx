import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppSnapshot, ImportSummary, MeleeBridge, ReplayCard } from '../shared/api';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import './styles.css';

declare global {
  interface Window { melee: MeleeBridge }
}

type Page = 'browse' | 'setup';
type AvailabilityFilter = 'all' | 'ready' | 'downloadable' | 'missing';

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('browse');
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
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
  const [acquisitionPhase, setAcquisitionPhase] = useState<'preparing' | 'downloading' | 'verifying' | 'ready' | null>(null);
  const [notice, setNotice] = useState('');

  async function refresh(): Promise<void> {
    setSnapshot(await window.melee.snapshot());
  }

  useEffect(() => {
    refresh().catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'The library could not load.'));
    return window.melee.onAcquisitionPhase((phase) => setAcquisitionPhase(phase));
  }, []);

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

  async function importReplays(kind: 'files' | 'folder'): Promise<void> {
    setBusy(true);
    setNotice('');
    try {
      const result: ImportSummary = kind === 'files' ? await window.melee.importFiles() : await window.melee.importFolder();
      await refresh();
      if (!result.cancelled) {
        const parts = [`${result.imported} added`];
        if (result.duplicates) parts.push(`${result.duplicates} already in library`);
        if (result.rejected) parts.push(`${result.rejected} unsupported or incomplete`);
        setNotice(parts.join(' · '));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Import failed.');
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
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Selection failed.');
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

  function selectRandom(): void {
    const unseen = cards.filter((card) => card.availability !== 'missing' && card.practiceStatus === 'unseen');
    if (unseen.length === 0) {
      setNotice('No unseen replays match these filters.');
      return;
    }
    setNotice('');
    setSelectedId(unseen[Math.floor(Math.random() * unseen.length)].id);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-symbol" aria-hidden="true"><span/><span/><span/></div><strong>Melee<br/>Replay</strong></div>
      <nav aria-label="Main navigation">
        <button className={page === 'browse' ? 'nav-link active' : 'nav-link'} onClick={() => setPage('browse')} aria-current={page === 'browse' ? 'page' : undefined}>Browse</button>
        <button className={page === 'setup' ? 'nav-link active' : 'nav-link'} onClick={() => setPage('setup')} aria-current={page === 'setup' ? 'page' : undefined}>Setup</button>
      </nav>
      <div className="sidebar-bottom"><span className="status-dot"/>{availableCount} local replay{availableCount === 1 ? '' : 's'}</div>
    </aside>

    <main className="main-content">
      {page === 'browse' ? <>
        <header className="page-head">
          <div><h1>Browse replays</h1><p>Select a game without seeing its result.</p></div>
          <div className="head-actions">
            <button className="button secondary" disabled={busy} onClick={() => importReplays('folder')}>Import folder</button>
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
                  <button className="button primary wide" disabled={!!acquisitionPhase} onClick={() => acquire(selected.id)}>{acquisitionPhase ? `${acquisitionPhase[0].toUpperCase()}${acquisitionPhase.slice(1)}…` : 'Download replay'}</button>
                  {acquisitionPhase && <button className="text-button" onClick={() => window.melee.cancelAcquisition()}>Cancel download</button>}
                </> : <button className="button primary wide" disabled>Practice unavailable in this build</button>}
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
        <button className="text-button" onClick={() => window.melee.openSlippiSetup().catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Could not open Slippi setup.'))}>Official Slippi setup ↗</button>
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

createRoot(document.getElementById('root')!).render(<App />);
