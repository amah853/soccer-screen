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
  goalFlash: document.getElementById('goalFlash'),
  goalFlag: document.getElementById('goalFlag'),
  goalFlagFallback: document.getElementById('goalFlagFallback'),
  goalTeam: document.getElementById('goalTeam'),
  goalScoreline: document.getElementById('goalScoreline'),
  confettiField: document.getElementById('confettiField')
};

let previousScore = null;
let nextRefreshMs = 30_000;
let lastState = null;
let shortcutCount = 0;
let shortcutLastPressAt = 0;
let simulatedGoalSide = 'home';
let goalAudioContext = null;
const activeGoalSounds = new Set();
const goalSoundPrimer = new Audio('/cheering.mp3');
goalSoundPrimer.preload = 'auto';
const PREGAME_COUNTDOWN_MS = 60 * 60_000;

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
  const nextMatch = state.nextMatch;
  const sportName = state.config?.sportName || 'football';
  const sportTitle = state.config?.sportTitle || 'Football';
  document.title = `Live ${sportTitle} Scoreboard`;

  if (!match) {
    if (shouldShowNextMatch(nextMatch)) {
      renderPregame(state, nextMatch, sportTitle);
      return;
    }

    elements.competition.textContent = 'No Active Games';
    elements.stage.textContent = sportTitle;
    elements.homeName.textContent = 'Home';
    elements.awayName.textContent = 'Away';
    setScore(elements.homeScore, '0');
    setScore(elements.awayScore, '0');
    setCrest(elements.homeCrest, elements.homeFallback, null, 'FC');
    setCrest(elements.awayCrest, elements.awayFallback, null, 'FC');
    elements.liveDot.classList.remove('is-live');
    elements.matchClock.textContent = `No active ${sportName} games`;
    elements.updateLine.textContent = idleUpdateText(state, nextMatch);
    window.requestAnimationFrame(fitTeamNames);
    previousScore = null;
    return;
  }

  elements.competition.textContent = match.competition?.name || sportTitle;
  elements.stage.textContent = match.stage || 'MATCH';
  elements.homeName.textContent = match.homeTeam?.name || 'Home';
  elements.awayName.textContent = match.awayTeam?.name || 'Away';
  window.requestAnimationFrame(fitTeamNames);

  const nextScore = { home: match.score.home, away: match.score.away };
  const scoringSide = getScoringSide(previousScore, nextScore);
  const scoreChanged = Boolean(scoringSide);
  setScore(elements.homeScore, String(match.score.home), scoreChanged && scoringSide === 'home');
  setScore(elements.awayScore, String(match.score.away), scoreChanged && scoringSide === 'away');
  if (scoreChanged && isLive(match.status)) triggerGoalCelebration(scoringSide, match);
  previousScore = nextScore;

  setCrest(elements.homeCrest, elements.homeFallback, match.homeTeam?.crest, match.homeTeam?.tla);
  setCrest(elements.awayCrest, elements.awayFallback, match.awayTeam?.crest, match.awayTeam?.tla);

  elements.liveDot.classList.toggle('is-live', isLive(match.status));
  updateClock(state);
  elements.updateLine.textContent = updateText(state, match);
}

function renderPregame(state, match, sportTitle) {
  elements.competition.textContent = match.competition?.name || sportTitle;
  elements.stage.textContent = match.stage || 'MATCH';
  elements.homeName.textContent = match.homeTeam?.name || 'Home';
  elements.awayName.textContent = match.awayTeam?.name || 'Away';
  setScore(elements.homeScore, '0');
  setScore(elements.awayScore, '0');
  setCrest(elements.homeCrest, elements.homeFallback, match.homeTeam?.crest, match.homeTeam?.tla);
  setCrest(elements.awayCrest, elements.awayFallback, match.awayTeam?.crest, match.awayTeam?.tla);
  elements.liveDot.classList.remove('is-live');
  elements.matchClock.textContent = nextMatchClockText(match);
  elements.updateLine.textContent = updateText(state, match);
  window.requestAnimationFrame(fitTeamNames);
  previousScore = null;
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
  if (state?.selectedMatch) {
    elements.matchClock.textContent = clockText(state);
    return;
  }
  if (shouldShowNextMatch(state?.nextMatch)) {
    elements.matchClock.textContent = nextMatchClockText(state.nextMatch);
  }
}

function clockText(state) {
  const match = state.selectedMatch;
  if (match.status === 'FINISHED') return 'FT';
  if (match.status === 'PAUSED') return `HALFTIME - ${formatElapsed(pausedElapsedSeconds(state))}`;
  if (match.status === 'IN_PLAY') return formatElapsed(liveElapsedSeconds(state));
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

function pausedElapsedSeconds(state) {
  const match = state.selectedMatch;
  if (!Number.isFinite(match.minute)) return elapsedSecondsFromKickoff(match.utcDate);

  const baseSeconds = Math.max(0, match.minute * 60);
  const snapshotTime = new Date(state.lastUpdated || match.lastUpdated || Date.now()).getTime();
  const localDeltaSeconds = Number.isFinite(snapshotTime)
    ? Math.max(0, Math.floor((Date.now() - snapshotTime) / 1000))
    : 0;
  return Math.min(130 * 60, baseSeconds + localDeltaSeconds);
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

function idleUpdateText(state, nextMatch) {
  const parts = [state.message || 'No active games right now.'];
  if (nextMatch) {
    const home = nextMatch.homeTeam?.name || 'Home';
    const away = nextMatch.awayTeam?.name || 'Away';
    parts.push(`Next: ${home} vs ${away} at ${kickoffText(nextMatch.utcDate)}`);
  }
  const next = state.nextApiPollAt ? new Date(state.nextApiPollAt) : null;
  if (next) {
    parts.push(`Next schedule check ${next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  }
  return parts.filter(Boolean).join(' · ');
}

function shouldShowNextMatch(match) {
  if (!match?.utcDate) return false;
  const kickoff = new Date(match.utcDate).getTime();
  if (!Number.isFinite(kickoff)) return false;
  return Date.now() >= kickoff - PREGAME_COUNTDOWN_MS;
}

function nextMatchClockText(match) {
  const kickoff = new Date(match.utcDate).getTime();
  if (!Number.isFinite(kickoff)) return 'Kickoff TBA';

  const remainingSeconds = Math.ceil((kickoff - Date.now()) / 1000);
  if (remainingSeconds <= 0) return 'Kickoff now';

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `Starts in ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isLive(status) {
  return status === 'IN_PLAY' || status === 'PAUSED';
}

function getScoringSide(previous, next) {
  if (!previous || !next) return null;
  if (next.home > previous.home) return 'home';
  if (next.away > previous.away) return 'away';
  if (next.home !== previous.home) return 'home';
  if (next.away !== previous.away) return 'away';
  return null;
}

function triggerGoalCelebration(side, match) {
  const team = side === 'home' ? match.homeTeam : match.awayTeam;
  elements.goalTeam.textContent = team?.name || 'Goal';
  elements.goalScoreline.textContent = `${match.score.home} - ${match.score.away}`;
  setGoalFlag(team?.crest, team?.tla || 'FC');
  buildConfetti();
  playGoalSound();
  flashGoal();
}

function setGoalFlag(src, initials) {
  elements.goalFlagFallback.textContent = initials || 'FC';
  if (!src) {
    elements.goalFlag.removeAttribute('src');
    elements.goalFlag.classList.remove('is-visible');
    return;
  }

  if (elements.goalFlag.getAttribute('src') !== src) {
    elements.goalFlag.src = src;
  }
  elements.goalFlag.onload = () => elements.goalFlag.classList.add('is-visible');
  elements.goalFlag.onerror = () => elements.goalFlag.classList.remove('is-visible');
  if (elements.goalFlag.complete && elements.goalFlag.naturalWidth > 0) {
    elements.goalFlag.classList.add('is-visible');
  }
}

function buildConfetti() {
  const colors = ['#f2c94c', '#ffffff', '#28d17c', '#e83d52', '#49a7ff'];
  const fragment = document.createDocumentFragment();
  elements.confettiField.replaceChildren();

  for (let index = 0; index < 120; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.setProperty('--x', `${Math.random() * 100}vw`);
    piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 26}vw`);
    piece.style.setProperty('--delay', `${Math.random() * 0.75}s`);
    piece.style.setProperty('--duration', `${3.2 + Math.random() * 2.2}s`);
    piece.style.setProperty('--rotate', `${Math.random() * 920 - 460}deg`);
    piece.style.setProperty('--color', colors[index % colors.length]);
    piece.style.setProperty('--w', `${6 + Math.random() * 9}px`);
    piece.style.setProperty('--h', `${10 + Math.random() * 18}px`);
    fragment.appendChild(piece);
  }

  elements.confettiField.appendChild(fragment);
}

function flashGoal() {
  elements.scoreboard.classList.remove('goal-active');
  elements.goalFlash.classList.remove('show');
  void elements.goalFlash.offsetWidth;
  elements.scoreboard.classList.add('goal-active');
  elements.goalFlash.classList.add('show');
  window.setTimeout(() => {
    elements.goalFlash.classList.remove('show');
    elements.scoreboard.classList.remove('goal-active');
  }, 5400);
}

function playGoalSound() {
  const audio = new Audio('/cheering.mp3');
  audio.volume = 1;
  audio.preload = 'auto';
  activeGoalSounds.add(audio);
  audio.addEventListener('ended', () => activeGoalSounds.delete(audio), { once: true });
  audio.addEventListener('error', () => activeGoalSounds.delete(audio), { once: true });

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) {
    try {
      goalAudioContext ||= new AudioContextClass();
      goalAudioContext.resume?.().catch(() => {});

      const source = goalAudioContext.createMediaElementSource(audio);
      const gain = goalAudioContext.createGain();
      const compressor = goalAudioContext.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 8;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.18;
      gain.gain.value = 3;
      source.connect(gain);
      gain.connect(compressor);
      compressor.connect(goalAudioContext.destination);
    } catch {
      // Fall back to the normal HTMLAudioElement output below.
    }
  }

  audio.currentTime = 0;
  audio.play().catch(() => activeGoalSounds.delete(audio));
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

window.addEventListener('keydown', (event) => {
  const isShortcut = event.metaKey && event.shiftKey && event.key.toLowerCase() === 's';
  if (!isShortcut) return;

  event.preventDefault();
  const now = Date.now();
  shortcutCount = now - shortcutLastPressAt < 1600 ? shortcutCount + 1 : 1;
  shortcutLastPressAt = now;

  if (shortcutCount >= 5) {
    shortcutCount = 0;
    simulateGoal();
  }
});

window.setInterval(() => {
  if (isLive(lastState?.selectedMatch?.status) || shouldShowNextMatch(lastState?.nextMatch)) {
    updateClock(lastState);
  } else if (lastState?.nextMatch) {
    render(lastState);
  }
}, 1000);

refresh();

function simulateGoal() {
  const target = simulatedGoalSide === 'home' ? elements.homeScore : elements.awayScore;
  const current = Number.parseInt(target.textContent, 10);
  const nextValue = Number.isFinite(current) ? current + 1 : 1;
  setScore(target, String(nextValue), true);

  const baseMatch = lastState?.selectedMatch;
  const simulatedMatch = baseMatch
    ? structuredClone(baseMatch)
    : {
        homeTeam: { name: 'Home', tla: 'HOM', crest: null },
        awayTeam: { name: 'Away', tla: 'AWY', crest: null },
        score: { home: 0, away: 0 }
      };

  simulatedMatch.score = {
    home: Number.parseInt(elements.homeScore.textContent, 10) || 0,
    away: Number.parseInt(elements.awayScore.textContent, 10) || 0
  };
  triggerGoalCelebration(simulatedGoalSide, simulatedMatch);
  simulatedGoalSide = simulatedGoalSide === 'home' ? 'away' : 'home';
}
