const elements = {
  scoreboard: document.getElementById('scoreboard'),
  competition: document.getElementById('competition'),
  stage: document.getElementById('stage'),
  homeName: document.getElementById('homeName'),
  awayName: document.getElementById('awayName'),
  homeScore: document.getElementById('homeScore'),
  awayScore: document.getElementById('awayScore'),
  homeCrest: document.getElementById('homeCrest'),
  awayCrest: document.getElementById('awayCrest'),
  homeFallback: document.getElementById('homeFallback'),
  awayFallback: document.getElementById('awayFallback'),
  liveDot: document.getElementById('liveDot'),
  matchClock: document.getElementById('matchClock'),
  updateLine: document.getElementById('updateLine'),
  goalFlash: document.getElementById('goalFlash')
};

let previousScore = null;
let nextRefreshMs = 30_000;
let lastState = null;

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const state = await response.json();
    lastState = state;
    nextRefreshMs = state.clientRefreshMs || nextRefreshMs;
    render(state);
  } catch {
    elements.matchClock.textContent = 'Waiting for live match data...';
    elements.updateLine.textContent = 'Connection lost. Retrying locally.';
    nextRefreshMs = 15_000;
  } finally {
    window.setTimeout(refresh, nextRefreshMs);
  }
}

function render(state) {
  const match = state.selectedMatch;
  const sportName = state.config?.sportName || 'football';
  const sportTitle = state.config?.sportTitle || 'Football';
  document.title = `Live ${sportTitle} Scoreboard`;

  if (!match) {
    elements.competition.textContent = sportTitle;
    elements.stage.textContent = 'MATCH';
    elements.homeName.textContent = 'Home';
    elements.awayName.textContent = 'Away';
    setScore(elements.homeScore, '0');
    setScore(elements.awayScore, '0');
    setCrest(elements.homeCrest, elements.homeFallback, null, 'FC');
    setCrest(elements.awayCrest, elements.awayFallback, null, 'FC');
    elements.liveDot.classList.remove('is-live');
    elements.matchClock.textContent = `Waiting for live ${sportName} match data...`;
    elements.updateLine.textContent = state.message || 'Last update pending';
    window.requestAnimationFrame(fitTeamNames);
    previousScore = null;
    return;
  }

  elements.competition.textContent = match.competition?.name || sportTitle;
  elements.stage.textContent = match.stage || 'MATCH';
  elements.homeName.textContent = match.homeTeam?.name || 'Home';
  elements.awayName.textContent = match.awayTeam?.name || 'Away';
  window.requestAnimationFrame(fitTeamNames);

  const nextScore = `${match.score.home}-${match.score.away}`;
  const scoreChanged = previousScore && previousScore !== nextScore;
  setScore(elements.homeScore, String(match.score.home), scoreChanged);
  setScore(elements.awayScore, String(match.score.away), scoreChanged);
  if (scoreChanged && isLive(match.status)) flashGoal();
  previousScore = nextScore;

  setCrest(elements.homeCrest, elements.homeFallback, match.homeTeam?.crest, match.homeTeam?.tla);
  setCrest(elements.awayCrest, elements.awayFallback, match.awayTeam?.crest, match.awayTeam?.tla);

  elements.liveDot.classList.toggle('is-live', isLive(match.status));
  updateClock(state);
  elements.updateLine.textContent = updateText(state, match);
}

function setScore(element, value, bump = false) {
  if (element.textContent === value) return;
  element.textContent = value;
  if (bump) {
    element.classList.remove('bump');
    void element.offsetWidth;
    element.classList.add('bump');
    window.setTimeout(() => element.classList.remove('bump'), 420);
  }
}

function setCrest(img, fallback, src, initials) {
  fallback.textContent = initials || 'FC';
  if (!src) {
    img.removeAttribute('src');
    img.classList.remove('is-visible');
    return;
  }
  if (img.getAttribute('src') !== src) {
    img.src = src;
  }
  img.onload = () => img.classList.add('is-visible');
  img.onerror = () => img.classList.remove('is-visible');
  if (img.complete && img.naturalWidth > 0) img.classList.add('is-visible');
}

function updateClock(state = lastState) {
  if (!state?.selectedMatch) return;
  elements.matchClock.textContent = clockText(state);
}

function clockText(state) {
  const match = state.selectedMatch;
  if (match.status === 'FINISHED') return 'FT';
  if (match.status === 'PAUSED') return 'HT';
  if (match.status === 'IN_PLAY') return `${formatElapsed(liveElapsedSeconds(state))} LIVE`;
  return kickoffText(match.utcDate);
}

function liveElapsedSeconds(state) {
  const match = state.selectedMatch;
  if (!Number.isFinite(match.minute)) return elapsedSecondsFromKickoff(match.utcDate);

  const baseSeconds = Math.max(0, match.minute * 60);
  const snapshotTime = new Date(state.lastUpdated || match.lastUpdated || Date.now()).getTime();
  const localDeltaSeconds = Number.isFinite(snapshotTime)
    ? Math.max(0, Math.floor((Date.now() - snapshotTime) / 1000))
    : 0;
  return Math.min(130 * 60, baseSeconds + localDeltaSeconds);
}

function elapsedSecondsFromKickoff(utcDate) {
  const kickoff = new Date(utcDate).getTime();
  if (!Number.isFinite(kickoff)) return 0;
  return Math.min(130 * 60, Math.max(0, Math.floor((Date.now() - kickoff) / 1000)));
}

function formatElapsed(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function kickoffText(utcDate) {
  if (!utcDate) return 'Kickoff TBA';
  return new Intl.DateTimeFormat([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(utcDate));
}

function updateText(state, match) {
  const updated = state.lastUpdated ? new Date(state.lastUpdated) : null;
  const updatedText = updated
    ? `Last updated ${updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
    : 'Last updated pending';
  const next = state.nextApiPollAt ? new Date(state.nextApiPollAt) : null;
  const nextText = next ? `Next check ${next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  return [updatedText, nextText].filter(Boolean).join(' · ');
}

function isLive(status) {
  return status === 'IN_PLAY' || status === 'PAUSED';
}

function flashGoal() {
  elements.goalFlash.classList.remove('show');
  void elements.goalFlash.offsetWidth;
  elements.goalFlash.classList.add('show');
}

function fitTeamNames() {
  for (const element of [elements.homeName, elements.awayName]) {
    element.style.fontSize = '';
    const minSize = window.innerWidth < 900 ? 18 : 30;
    let size = Number.parseFloat(window.getComputedStyle(element).fontSize);
    while (element.scrollWidth > element.clientWidth && size > minSize) {
      size -= 2;
      element.style.fontSize = `${size}px`;
    }
  }
}

window.addEventListener('resize', () => {
  if (lastState) window.requestAnimationFrame(fitTeamNames);
});

window.setInterval(() => {
  if (lastState?.selectedMatch?.status === 'IN_PLAY') updateClock(lastState);
}, 1000);

refresh();
