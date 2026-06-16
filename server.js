import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const ESPN_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const TOKEN = process.env.FOOTBALL_DATA_API_TOKEN || process.env.FOOTBALL_DATA_TOKEN || '';
const SPORT_NAME = normalizeSportName(process.env.SCOREBOARD_SPORT_NAME || process.env.SPORT_NAME || 'football');
const SELF_UPDATE_REMOTE = process.env.SCOREBOARD_UPDATE_REMOTE || 'origin';
const SELF_UPDATE_ENABLED = process.env.SCOREBOARD_AUTO_UPDATE !== '0';
const DATA_DIR = path.join(__dirname, 'data');
const CREST_DIR = path.join(DATA_DIR, 'crests');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const LIVE_POLL_MS = 5_000;
const SCHEDULE_POLL_MS = 5_000;
const ERROR_RETRY_MS = 5 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const LOW_BUCKET_THRESHOLD = 1;
const UPCOMING_WINDOW_DAYS = 10;
const KICKOFF_WATCH_WINDOW_MS = 5 * 60_000;
const CLIENT_REFRESH_LIVE_MS = 1_000;
const CLIENT_REFRESH_IDLE_MS = 1_000;

const ESPN_LEAGUES = [
  { code: 'fifa.world', name: 'FIFA World Cup', weight: 1000 },
  { code: 'uefa.champions', name: 'UEFA Champions League', weight: 920 },
  { code: 'uefa.euro', name: 'UEFA European Championship', weight: 900 },
  { code: 'eng.1', name: 'Premier League', weight: 820 },
  { code: 'esp.1', name: 'LaLiga', weight: 810 },
  { code: 'ger.1', name: 'Bundesliga', weight: 800 },
  { code: 'ita.1', name: 'Serie A', weight: 790 },
  { code: 'fra.1', name: 'Ligue 1', weight: 780 }
];

const COMPETITION_WEIGHTS = new Map(ESPN_LEAGUES.map((competition) => [competition.code, competition.weight]));
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
  nextMatch: null,
  lastUpdated: null,
  nextApiPollAt: null,
  api: {
    lastRequestAt: null,
    requestsAvailable: null,
    requestCounterResetSeconds: null,
    requestCounterResetAt: null,
    throttleUntil: null
  },
  selfUpdate: {
    enabled: SELF_UPDATE_ENABLED,
    lastCheckedAt: null,
    lastResult: null,
    lastError: null
  },
  message: 'Starting scoreboard...',
  error: null,
  tokenConfigured: Boolean(TOKEN),
  config: {
    sportName: SPORT_NAME,
    sportTitle: titleCase(SPORT_NAME)
  },
  testGoal: null
};

let pollTimer = null;
let requestLog = [];
let headerThrottleUntil = 0;
let needsStartupLiveCheck = true;

await ensureDirectories();
await loadCache();
schedulePoll(100);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/state') {
      if (req.method !== 'GET') {
        sendJson(res, { error: 'Method not allowed' }, 405);
        return;
      }

      sendJson(res, {
        ...state,
        config: {
          sportName: SPORT_NAME,
          sportTitle: titleCase(SPORT_NAME)
        },
        clientRefreshMs: state.mode === 'live' || state.mode === 'kickoff-watch'
          ? CLIENT_REFRESH_LIVE_MS
          : CLIENT_REFRESH_IDLE_MS
      });
      return;
    }

    if (url.pathname === '/api/test-goal') {
      if (req.method !== 'POST') {
        sendJson(res, { error: 'Method not allowed' }, 405);
        return;
      }

      state.testGoal = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        triggeredAt: new Date().toISOString()
      };
      sendJson(res, { ok: true, testGoal: state.testGoal });
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
      nextMatch: cached.nextMatch || null,
      message: cached.selectedMatch ? 'Showing cached match data.' : cached.message || state.message,
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
    nextMatch: state.nextMatch,
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
    poll().catch(async (error) => {
      console.error('[poll] unexpected failure', error);
      state.error = error.message;
      if (isLiveStatus(state.selectedMatch?.status)) {
        state.mode = 'stale-live';
        state.message = 'Showing cached live match data.';
        await saveCache();
        schedulePoll(error.retryAfterMs || LIVE_POLL_MS);
        return;
      }

      clearActiveMatch();
      state.mode = 'error';
      state.message = 'No active games right now.';
      schedulePoll(error.retryAfterMs || ERROR_RETRY_MS);
    });
  }, Math.max(100, effectiveDelayMs));
}

async function poll() {
  state.tokenConfigured = Boolean(TOKEN);

  const shouldCheckLive = needsStartupLiveCheck || state.mode === 'starting' || state.mode === 'live' || shouldUseLiveEndpoint();

  if (shouldCheckLive) {
    const liveMatches = await fetchMatches({ status: 'LIVE' });
    needsStartupLiveCheck = false;
    const liveSelection = selectLiveMatch(liveMatches);

    if (liveSelection) {
      state.mode = 'live';
      state.selectedMatch = await normalizeMatch(liveSelection);
      state.nextMatch = null;
      state.lastUpdated = new Date().toISOString();
      state.message = 'Live match data loaded.';
      state.error = null;
      await saveCache();
      schedulePoll(LIVE_POLL_MS);
      return;
    }

    const confirmedMatch = await confirmCurrentLiveMatch();
    if (confirmedMatch) {
      state.mode = 'live';
      state.selectedMatch = confirmedMatch;
      state.nextMatch = null;
      state.lastUpdated = new Date().toISOString();
      state.message = 'Live match data loaded.';
      state.error = null;
      await saveCache();
      schedulePoll(LIVE_POLL_MS);
      return;
    }

    if (state.nextMatch && shouldUseLiveEndpoint()) {
      state.mode = 'kickoff-watch';
      state.selectedMatch = null;
      state.message = 'No active games right now.';
      state.lastUpdated = new Date().toISOString();
      await saveCache();
      await checkForSelfUpdate();
      schedulePoll(LIVE_POLL_MS);
      return;
    }
  }

  const upcomingMatches = await fetchUpcomingMatches();
  const upcomingSelection = selectUpcomingMatch(upcomingMatches);

  if (upcomingSelection) {
    state.mode = 'idle';
    state.selectedMatch = null;
    state.nextMatch = await normalizeMatch(upcomingSelection);
    state.lastUpdated = new Date().toISOString();
    state.message = 'No active games right now.';
    state.error = null;
    await saveCache();
    await checkForSelfUpdate();
    schedulePoll(nextIdleDelay(upcomingSelection.utcDate));
    return;
  }

  state.mode = 'waiting';
  state.selectedMatch = null;
  state.nextMatch = null;
  state.message = 'No active games right now.';
  state.lastUpdated = new Date().toISOString();
  await saveCache();
  await checkForSelfUpdate();
  schedulePoll(SCHEDULE_POLL_MS);
}

function clearActiveMatch() {
  state.selectedMatch = null;
}

async function confirmCurrentLiveMatch() {
  if (!state.selectedMatch?.id || !isLiveStatus(state.selectedMatch.status)) return null;

  const match = await fetchMatchById(state.selectedMatch.id);
  if (isLiveStatus(match?.status)) return normalizeMatch(match);

  clearActiveMatch();
  return null;
}

function shouldUseLiveEndpoint() {
  const kickoffSource = state.nextMatch || state.selectedMatch;
  if (!kickoffSource?.utcDate) return false;
  const kickoff = new Date(kickoffSource.utcDate).getTime();
  return Number.isFinite(kickoff) && Date.now() >= kickoff - KICKOFF_WATCH_WINDOW_MS;
}

function nextIdleDelay(utcDate) {
  const kickoff = new Date(utcDate).getTime();
  if (!Number.isFinite(kickoff)) return SCHEDULE_POLL_MS;
  const untilWatchWindow = kickoff - KICKOFF_WATCH_WINDOW_MS - Date.now();
  if (untilWatchWindow <= 0) return LIVE_POLL_MS;
  return Math.min(SCHEDULE_POLL_MS, Math.max(LIVE_POLL_MS, untilWatchWindow));
}

async function checkForSelfUpdate() {
  if (!SELF_UPDATE_ENABLED) return;

  state.selfUpdate.lastCheckedAt = new Date().toISOString();
  state.selfUpdate.lastError = null;

  try {
    const hasLocalChanges = await runGitText(['status', '--porcelain']);
    if (hasLocalChanges) {
      state.selfUpdate.lastResult = 'Skipped self-update: local checkout has uncommitted changes.';
      return;
    }

    const branch = await currentGitBranch();
    if (!branch) {
      state.selfUpdate.lastResult = 'Skipped self-update: current checkout is detached.';
      return;
    }

    await runGit(['fetch', '--quiet', SELF_UPDATE_REMOTE, branch]);
    const localHead = await runGitText(['rev-parse', 'HEAD']);
    const remoteHead = await runGitText(['rev-parse', `${SELF_UPDATE_REMOTE}/${branch}`]);

    if (localHead === remoteHead) {
      state.selfUpdate.lastResult = `Already up to date with ${SELF_UPDATE_REMOTE}/${branch}.`;
      return;
    }

    const remoteContainsLocal = await gitSucceeds(['merge-base', '--is-ancestor', 'HEAD', `${SELF_UPDATE_REMOTE}/${branch}`]);
    if (!remoteContainsLocal) {
      state.selfUpdate.lastResult = `Skipped self-update: local HEAD has diverged from ${SELF_UPDATE_REMOTE}/${branch}.`;
      return;
    }

    console.log(`[self-update] ${SELF_UPDATE_REMOTE}/${branch} is ahead; pulling and rebooting.`);
    await runGit(['pull', '--ff-only', SELF_UPDATE_REMOTE, branch]);
    state.selfUpdate.lastResult = `Updated to ${remoteHead}; rebooting.`;
    await execFileAsync('sudo', ['-n', 'reboot'], { cwd: __dirname });
  } catch (error) {
    const message = error.stderr?.trim() || error.stdout?.trim() || error.message;
    state.selfUpdate.lastError = message;
    state.selfUpdate.lastResult = 'Self-update failed.';
    console.warn(`[self-update] ${message}`);
  }
}

async function currentGitBranch() {
  const branch = await runGitText(['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch === 'HEAD' ? null : branch;
}

async function runGit(args) {
  return execFileAsync('git', args, { cwd: __dirname });
}

async function runGitText(args) {
  const { stdout } = await runGit(args);
  return stdout.trim();
}

async function gitSucceeds(args) {
  try {
    await runGit(args);
    return true;
  } catch {
    return false;
  }
}

async function fetchMatches(filters) {
  const events = await fetchEspnScoreboards();
  const normalized = await Promise.all(events.map((event) => normalizeMatch(event)));
  if (filters?.status === 'LIVE') {
    return normalized.filter((match) => isLiveStatus(match.status));
  }
  return normalized;
}

async function fetchMatchById(id) {
  const leagueCode = state.selectedMatch?.providerLeague || state.nextMatch?.providerLeague;
  if (!leagueCode) return null;

  const payload = await espnFetch(`/${leagueCode}/summary?${new URLSearchParams({ event: String(id) })}`);
  const competition = payload.header?.competitions?.[0];
  if (!competition) return null;

  return {
    id: payload.header?.id || id,
    date: competition.date || payload.header?.date || state.selectedMatch?.utcDate,
    name: payload.header?.name || '',
    shortName: payload.header?.shortName || '',
    status: competition.status || payload.header?.status,
    competitions: [competition],
    providerLeague: leagueCode,
    providerLeagueName: leagueName(leagueCode)
  };
}

async function fetchUpcomingMatches() {
  const now = new Date();
  const end = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60_000);
  const events = await fetchEspnScoreboards(`${formatDateCompact(now)}-${formatDateCompact(end)}`);
  const normalized = await Promise.all(events.map((event) => normalizeMatch(event)));
  return normalized.filter((match) => {
    const kickoff = new Date(match.utcDate).getTime();
    return kickoff >= Date.now() - 60_000 && ['TIMED', 'SCHEDULED'].includes(match.status);
  });
}

async function fetchEspnScoreboards(dates) {
  const results = await Promise.allSettled(ESPN_LEAGUES.map(async (league) => {
    const params = new URLSearchParams();
    if (dates) params.set('dates', dates);
    const query = params.toString();
    const payload = await espnFetch(`/${league.code}/scoreboard${query ? `?${query}` : ''}`);
    return (Array.isArray(payload.events) ? payload.events : []).map((event) => ({
      ...event,
      providerLeague: league.code,
      providerLeagueName: payload.leagues?.[0]?.name || league.name
    }));
  }));

  const events = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      events.push(...result.value);
    } else {
      console.warn(`[espn] scoreboard fetch failed: ${result.reason?.message || result.reason}`);
    }
  }
  return events;
}

async function espnFetch(endpoint) {
  const response = await fetch(`${ESPN_API_BASE}${endpoint}`, {
    headers: {
      'User-Agent': 'soccer-screen-raspberry-pi/1.0'
    }
  });

  state.api.lastRequestAt = new Date().toISOString();

  if (response.status === 429) {
    const retryAfterMs = retryDelayFromHeaders(response.headers) || RATE_LIMIT_BACKOFF_MS;
    state.error = 'ESPN API rate limit reached; backing off before the next request.';
    throw Object.assign(new Error('Rate limit reached'), { retryAfterMs });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ESPN API ${response.status}: ${text || response.statusText}`);
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
  if (match?.homeTeam && match?.awayTeam && match?.score) return match;
  if (Array.isArray(match?.competitions)) return normalizeEspnMatch(match);

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
    lastUpdated: match.lastUpdated || null,
    providerLeague: match.providerLeague || null
  };
}

async function normalizeEspnMatch(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const homeCompetitor = competitors.find((competitor) => competitor.homeAway === 'home') || competitors[0] || {};
  const awayCompetitor = competitors.find((competitor) => competitor.homeAway === 'away') || competitors[1] || {};
  const status = competition.status || event.status || {};
  const statusType = status.type || {};
  const leagueCode = event.providerLeague || event.league?.slug || '';

  return {
    id: event.id || competition.id,
    status: espnStatus(statusType),
    minute: espnMinute(status),
    utcDate: event.date || competition.date || null,
    competition: {
      code: leagueCode,
      name: event.providerLeagueName || leagueName(leagueCode) || 'Soccer'
    },
    stage: formatStage(event.season?.slug || event.season?.type?.name || ''),
    group: '',
    homeTeam: await normalizeTeam(homeCompetitor.team),
    awayTeam: await normalizeTeam(awayCompetitor.team),
    score: {
      home: scoreValue(homeCompetitor.score),
      away: scoreValue(awayCompetitor.score)
    },
    lastUpdated: event.lastUpdated || null,
    providerLeague: leagueCode
  };
}

async function normalizeTeam(team = {}) {
  const logo = team.crest || team.logo || team.logos?.find((item) => item.rel?.includes('default'))?.href || team.logos?.[0]?.href || null;
  const name = team.shortName || team.shortDisplayName || team.name || team.displayName || team.tla || team.abbreviation || 'TBD';
  const fullName = team.name || team.displayName || team.shortName || team.shortDisplayName || 'TBD';

  return {
    id: team.id || null,
    name,
    fullName,
    tla: team.tla || team.abbreviation || initials(fullName),
    crest: await ensureCrest({ ...team, crest: logo })
  };
}

function scoreValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

function formatDateCompact(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function formatStage(stage) {
  if (!stage) return 'MATCH';
  return stage.replaceAll('_', ' ').replaceAll('-', ' ').toUpperCase();
}

function espnStatus(type = {}) {
  if (type.state === 'in') return type.name === 'STATUS_HALFTIME' ? 'PAUSED' : 'IN_PLAY';
  if (type.state === 'pre') return 'TIMED';
  if (type.state === 'post' || type.completed) return 'FINISHED';
  return 'SCHEDULED';
}

function espnMinute(status = {}) {
  if (!Number.isFinite(status.clock)) return null;
  return Math.max(0, Math.floor(status.clock / 60));
}

function leagueName(code) {
  return ESPN_LEAGUES.find((league) => league.code === code)?.name || '';
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

function isLiveStatus(status) {
  return status === 'IN_PLAY' || status === 'PAUSED';
}

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  let text = '';
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export {
  importanceScore,
  selectLiveMatch,
  selectUpcomingMatch,
  formatStage
};
