import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const API_BASE = 'https://api.football-data.org/v4';
const TOKEN = process.env.FOOTBALL_DATA_API_TOKEN || process.env.FOOTBALL_DATA_TOKEN || '';
const SPORT_NAME = normalizeSportName(process.env.SCOREBOARD_SPORT_NAME || process.env.SPORT_NAME || 'football');
const DATA_DIR = path.join(__dirname, 'data');
const CREST_DIR = path.join(DATA_DIR, 'crests');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const LIVE_POLL_MS = 30_000;
const IDLE_POLL_MS = 12 * 60_000;
const ERROR_RETRY_MS = 5 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const LOW_BUCKET_THRESHOLD = 1;
const UPCOMING_WINDOW_DAYS = 14;
const KICKOFF_WATCH_WINDOW_MS = 5 * 60_000;
const CLIENT_REFRESH_LIVE_MS = 5_000;
const CLIENT_REFRESH_IDLE_MS = 30_000;

const MAJOR_COMPETITIONS = [
  { code: 'WC', name: 'FIFA World Cup', weight: 1000 },
  { code: 'CL', name: 'UEFA Champions League', weight: 920 },
  { code: 'EC', name: 'UEFA European Championship', weight: 900 },
  { code: 'PL', name: 'Premier League', weight: 820 },
  { code: 'PD', name: 'LaLiga', weight: 810 },
  { code: 'BL1', name: 'Bundesliga', weight: 800 },
  { code: 'SA', name: 'Serie A', weight: 790 },
  { code: 'FL1', name: 'Ligue 1', weight: 780 }
];

const COMPETITION_CODES = MAJOR_COMPETITIONS.map((competition) => competition.code).join(',');
const COMPETITION_WEIGHTS = new Map(MAJOR_COMPETITIONS.map((competition) => [competition.code, competition.weight]));
const STAGE_WEIGHTS = new Map([
  ['FINAL', 100],
  ['THIRD_PLACE', 90],
  ['SEMI_FINALS', 85],
  ['QUARTER_FINALS', 75],
  ['LAST_16', 65],
  ['GROUP_STAGE', 40],
  ['REGULAR_SEASON', 20]
]);

let state = {
  mode: 'starting',
  selectedMatch: null,
  lastUpdated: null,
  nextApiPollAt: null,
  api: {
    lastRequestAt: null,
    requestsAvailable: null,
    requestCounterResetSeconds: null,
    requestCounterResetAt: null,
    throttleUntil: null
  },
  message: 'Starting scoreboard...',
  error: null,
  tokenConfigured: Boolean(TOKEN),
  config: {
    sportName: SPORT_NAME,
    sportTitle: titleCase(SPORT_NAME)
  }
};

let pollTimer = null;
let requestLog = [];
let headerThrottleUntil = 0;

await ensureDirectories();
await loadCache();
schedulePoll(100);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/state') {
      sendJson(res, {
        ...state,
        config: {
          sportName: SPORT_NAME,
          sportTitle: titleCase(SPORT_NAME)
        },
        clientRefreshMs: state.mode === 'live' ? CLIENT_REFRESH_LIVE_MS : CLIENT_REFRESH_IDLE_MS
      });
      return;
    }

    if (url.pathname.startsWith('/crests/')) {
      await serveCrest(url.pathname, res);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error('[server] request failed', error);
    sendJson(res, { error: 'Internal server error' }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Scoreboard running at http://localhost:${PORT}`);
  if (!TOKEN) {
    console.warn('FOOTBALL_DATA_API_TOKEN is not set. The UI will stay in waiting mode until a free football-data.org token is configured.');
  }
});

async function ensureDirectories() {
  await fs.mkdir(CREST_DIR, { recursive: true });
}

async function loadCache() {
  try {
    const cached = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    state = {
      ...state,
      ...cached,
      mode: cached.mode === 'live' ? 'stale-live' : cached.mode || 'cached',
      message: cached.selectedMatch ? 'Showing cached match data.' : state.message,
      tokenConfigured: Boolean(TOKEN)
    };
  } catch {
    // First run without cached data.
  }
}

async function saveCache() {
  const cachePayload = {
    mode: state.mode,
    selectedMatch: state.selectedMatch,
    lastUpdated: state.lastUpdated,
    message: state.message,
    error: state.error
  };
  await fs.writeFile(CACHE_FILE, JSON.stringify(cachePayload, null, 2));
}

function schedulePoll(delayMs) {
  clearTimeout(pollTimer);
  const effectiveDelayMs = applyHeaderThrottle(delayMs);
  state.nextApiPollAt = new Date(Date.now() + effectiveDelayMs).toISOString();
  pollTimer = setTimeout(() => {
    poll().catch((error) => {
      console.error('[poll] unexpected failure', error);
      state.error = error.message;
      state.mode = state.selectedMatch ? 'cached' : 'error';
      state.message = state.selectedMatch ? 'Showing cached match data.' : 'Waiting for live match data...';
      schedulePoll(error.retryAfterMs || ERROR_RETRY_MS);
    });
  }, Math.max(100, effectiveDelayMs));
}

async function poll() {
  if (!TOKEN) {
    state.mode = state.selectedMatch ? 'cached' : 'waiting';
    state.message = state.selectedMatch ? 'Showing cached match data.' : 'Waiting for live match data...';
    state.error = 'A free football-data.org token is required for match endpoints.';
    state.tokenConfigured = false;
    schedulePoll(IDLE_POLL_MS);
    return;
  }

  state.tokenConfigured = true;

  const shouldCheckLive = state.mode === 'starting' || state.mode === 'live' || shouldUseLiveEndpoint();

  if (shouldCheckLive) {
    const liveMatches = await fetchMatches({ status: 'LIVE' });
    const liveSelection = selectLiveMatch(liveMatches);

    if (liveSelection) {
      state.mode = 'live';
      state.selectedMatch = await normalizeMatch(liveSelection);
      state.lastUpdated = new Date().toISOString();
      state.message = 'Live match data loaded.';
      state.error = null;
      await saveCache();
      schedulePoll(LIVE_POLL_MS);
      return;
    }

    if (shouldUseLiveEndpoint()) {
      state.mode = state.selectedMatch ? 'cached' : 'waiting';
      state.message = state.selectedMatch ? 'Waiting for kickoff updates...' : 'Waiting for live match data...';
      state.lastUpdated = new Date().toISOString();
      await saveCache();
      schedulePoll(LIVE_POLL_MS);
      return;
    }
  }

  const upcomingMatches = await fetchUpcomingMatches();
  const upcomingSelection = selectUpcomingMatch(upcomingMatches);

  if (upcomingSelection) {
    state.mode = 'idle';
    state.selectedMatch = await normalizeMatch(upcomingSelection);
    state.lastUpdated = new Date().toISOString();
    state.message = 'Upcoming major match loaded.';
    state.error = null;
    await saveCache();
    schedulePoll(nextIdleDelay(upcomingSelection.utcDate));
    return;
  }

  state.mode = state.selectedMatch ? 'cached' : 'waiting';
  state.message = state.selectedMatch ? 'Showing cached match data.' : 'Waiting for live match data...';
  state.lastUpdated = new Date().toISOString();
  await saveCache();
  schedulePoll(IDLE_POLL_MS);
}

function shouldUseLiveEndpoint() {
  if (!state.selectedMatch?.utcDate) return false;
  const kickoff = new Date(state.selectedMatch.utcDate).getTime();
  return Number.isFinite(kickoff) && Date.now() >= kickoff - KICKOFF_WATCH_WINDOW_MS;
}

function nextIdleDelay(utcDate) {
  const kickoff = new Date(utcDate).getTime();
  if (!Number.isFinite(kickoff)) return IDLE_POLL_MS;
  const untilWatchWindow = kickoff - KICKOFF_WATCH_WINDOW_MS - Date.now();
  if (untilWatchWindow <= 0) return LIVE_POLL_MS;
  return Math.min(IDLE_POLL_MS, Math.max(LIVE_POLL_MS, untilWatchWindow));
}

async function fetchMatches(filters) {
  const params = new URLSearchParams({ competitions: COMPETITION_CODES, ...filters });
  const payload = await footballDataFetch(`/matches?${params.toString()}`);
  return Array.isArray(payload.matches) ? payload.matches : [];
}

async function fetchUpcomingMatches() {
  const now = new Date();
  const end = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60_000);
  const params = new URLSearchParams({
    competitions: COMPETITION_CODES,
    dateFrom: formatDate(now),
    dateTo: formatDate(end)
  });
  const payload = await footballDataFetch(`/matches?${params.toString()}`);
  return (Array.isArray(payload.matches) ? payload.matches : []).filter((match) => {
    const kickoff = new Date(match.utcDate).getTime();
    return kickoff >= Date.now() - 60_000 && ['TIMED', 'SCHEDULED'].includes(match.status);
  });
}

async function footballDataFetch(endpoint) {
  await enforceLocalRateLimit();

  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'X-Auth-Token': TOKEN,
      'User-Agent': 'soccer-screen-raspberry-pi/1.0'
    }
  });

  recordRequest(response.headers);

  if (response.status === 429) {
    const retryAfterMs = retryDelayFromHeaders(response.headers) || RATE_LIMIT_BACKOFF_MS;
    state.error = 'football-data.org rate limit reached; backing off until the request counter resets.';
    throw Object.assign(new Error('Rate limit reached'), { retryAfterMs });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`football-data.org ${response.status}: ${text || response.statusText}`);
  }

  return text ? JSON.parse(text) : {};
}

async function enforceLocalRateLimit() {
  const now = Date.now();
  requestLog = requestLog.filter((timestamp) => now - timestamp < 60_000);
  if (requestLog.length >= 2) {
    const waitMs = 60_000 - (now - requestLog[0]) + 250;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  requestLog.push(Date.now());
}

function recordRequest(headers) {
  const resetSeconds = numericHeader(headers, 'x-requestcounter-reset');
  const requestsAvailable = numericHeaderAny(headers, [
    'x-requestsavailable',
    'x-requests-available',
    'x-requests-available-minute'
  ]);
  const resetAt = Number.isFinite(resetSeconds) ? Date.now() + resetSeconds * 1000 : null;

  state.api.lastRequestAt = new Date().toISOString();
  state.api.requestsAvailable = requestsAvailable;
  state.api.requestCounterResetSeconds = resetSeconds;
  state.api.requestCounterResetAt = resetAt ? new Date(resetAt).toISOString() : null;

  if (Number.isFinite(requestsAvailable) && requestsAvailable <= LOW_BUCKET_THRESHOLD && resetAt) {
    headerThrottleUntil = Math.max(headerThrottleUntil, resetAt + 500);
    state.api.throttleUntil = new Date(headerThrottleUntil).toISOString();
  } else if (Date.now() >= headerThrottleUntil) {
    state.api.throttleUntil = null;
  }
}

function numericHeader(headers, name) {
  const value = headers.get(name);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numericHeaderAny(headers, names) {
  for (const name of names) {
    const value = numericHeader(headers, name);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function retryDelayFromHeaders(headers) {
  const retryAfter = numericHeader(headers, 'retry-after');
  if (Number.isFinite(retryAfter)) return Math.max(1, retryAfter) * 1000;

  const resetSeconds = numericHeader(headers, 'x-requestcounter-reset');
  if (Number.isFinite(resetSeconds)) return Math.max(1, resetSeconds) * 1000 + 500;

  return null;
}

function applyHeaderThrottle(delayMs) {
  const waitForHeaderMs = headerThrottleUntil - Date.now();
  if (waitForHeaderMs <= 0) {
    if (state.api.throttleUntil) state.api.throttleUntil = null;
    return delayMs;
  }
  return Math.max(delayMs, waitForHeaderMs);
}

function selectLiveMatch(matches) {
  return [...matches]
    .filter((match) => ['IN_PLAY', 'PAUSED'].includes(match.status))
    .sort((a, b) => importanceScore(b) - importanceScore(a))[0] || null;
}

function selectUpcomingMatch(matches) {
  return [...matches].sort((a, b) => {
    const dateDelta = new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime();
    if (dateDelta !== 0) return dateDelta;
    return importanceScore(b) - importanceScore(a);
  })[0] || null;
}

function importanceScore(match) {
  const competitionWeight = COMPETITION_WEIGHTS.get(match.competition?.code) || 0;
  const stageWeight = STAGE_WEIGHTS.get(match.stage) || 0;
  return competitionWeight * 100 + stageWeight;
}

async function normalizeMatch(match) {
  const homeScore = scoreValue(match.score?.fullTime?.home ?? match.score?.regularTime?.home ?? match.score?.halfTime?.home);
  const awayScore = scoreValue(match.score?.fullTime?.away ?? match.score?.regularTime?.away ?? match.score?.halfTime?.away);
  const homeTeam = await normalizeTeam(match.homeTeam);
  const awayTeam = await normalizeTeam(match.awayTeam);

  return {
    id: match.id,
    status: match.status,
    minute: match.minute,
    utcDate: match.utcDate,
    competition: {
      code: match.competition?.code || '',
      name: match.competition?.name || 'Football'
    },
    stage: formatStage(match.stage || match.group || ''),
    group: match.group || '',
    homeTeam,
    awayTeam,
    score: {
      home: homeScore,
      away: awayScore
    },
    lastUpdated: match.lastUpdated || null
  };
}

async function normalizeTeam(team = {}) {
  return {
    id: team.id || null,
    name: team.shortName || team.name || team.tla || 'TBD',
    fullName: team.name || team.shortName || 'TBD',
    tla: team.tla || initials(team.name || team.shortName || 'TBD'),
    crest: await ensureCrest(team)
  };
}

function scoreValue(value) {
  return Number.isInteger(value) ? value : 0;
}

async function ensureCrest(team = {}) {
  if (!team.id || !team.crest) return null;

  const extension = extensionFromUrl(team.crest);
  const filename = `${team.id}.${extension}`;
  const filePath = path.join(CREST_DIR, filename);
  const publicPath = `/crests/${filename}`;

  try {
    await fs.access(filePath);
    return publicPath;
  } catch {
    // Not cached yet.
  }

  try {
    const bytes = await fetchBinary(team.crest);
    await fs.writeFile(filePath, bytes);
    return publicPath;
  } catch (error) {
    console.warn(`[crest] failed to cache ${team.crest}: ${error.message}`);
    return null;
  }
}

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchBinary(response.headers.location).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function extensionFromUrl(url) {
  const pathname = new URL(url).pathname;
  const ext = path.extname(pathname).replace('.', '').toLowerCase();
  return ['svg', 'png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png';
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function serveCrest(urlPath, res) {
  const filename = path.basename(urlPath);
  const filePath = path.join(CREST_DIR, filename);
  try {
    await fs.access(filePath);
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Crest not cached');
  }
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg'
  }[ext] || 'application/octet-stream';
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatStage(stage) {
  if (!stage) return 'MATCH';
  return stage.replaceAll('_', ' ');
}

function initials(name) {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('') || 'FC';
}

function normalizeSportName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'soccer') return 'soccer';
  return 'football';
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export {
  importanceScore,
  selectLiveMatch,
  selectUpcomingMatch,
  formatStage
};
