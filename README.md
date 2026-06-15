# Raspberry Pi Live Football Scoreboard

A full-screen Chromium kiosk dashboard that shows one important football match from football-data.org while staying far below the free-plan rate limit.

## Important API note

football-data.org match endpoints require a free `X-Auth-Token`. This repo never commits a token and still starts without one, but live data cannot load from football-data.org until you provide your own free token.

## Run locally

```bash
git clone <repo-url>
cd soccer-screen
npm install
cp .env.example .env
# edit .env and add FOOTBALL_DATA_API_TOKEN from football-data.org
./start.sh
```

Open `http://localhost:3000`.

Without a token, the dashboard stays up and shows `Waiting for live match data...`.

## Configuration

Create `.env`:

```bash
FOOTBALL_DATA_API_TOKEN=your_free_token_here
PORT=3000
SCOREBOARD_SPORT_NAME=football
```

`.env` is ignored by git.

Set `SCOREBOARD_SPORT_NAME=soccer` if you want the generic fallback/title text to say soccer instead of football. The competition names still come from football-data.org.

## Rate-limiting strategy

- The browser never calls football-data.org. It only reads `/api/state` from the local Node server.
- Live mode uses one endpoint: `/v4/matches?status=LIVE&competitions=WC,CL,EC,PL,PD,BL1,SA,FL1`.
- Live mode polls every 30 seconds, so the app makes at most 2 football-data requests per minute.
- Idle mode polls every 12 minutes and fetches upcoming fixtures only with `/v4/matches?dateFrom=...&dateTo=...&competitions=...`.
- A local guard prevents more than 2 external API calls in any rolling minute.
- Every football-data.org response is inspected for `X-RequestsAvailable` and `X-RequestCounter-Reset`.
- If the remaining request bucket drops to 1 or lower, the next API poll is delayed until the server-provided reset time.
- If football-data.org returns `429`, polling uses `Retry-After` when present, otherwise `X-RequestCounter-Reset`, otherwise a 15 minute fallback. The UI keeps the cached match throughout.

## Match selection

The server displays one match:

1. Live matches first (`IN_PLAY` or `PAUSED`, via the API `LIVE` filter).
2. If multiple matches are live, competition importance wins:
   World Cup, Champions League, European Championship, Premier League, LaLiga, Bundesliga, Serie A, Ligue 1.
3. If no match is live, the next upcoming major match in the configured competitions is displayed.

## Caching

- Last selected match state is written to `data/cache.json`.
- If the API fails or the Pi loses network, the UI keeps showing the cached match.
- Team crests are downloaded once from the football-data crest URL and stored in `data/crests/`.
- The frontend always uses local crest URLs after caching, so image refreshes do not repeatedly hit the remote crest host.

## Raspberry Pi kiosk setup

Install Node.js 18+ and Chromium:

```bash
sudo apt update
sudo apt install -y nodejs npm chromium-browser
```

Clone the repo and run once:

```bash
git clone <repo-url> ~/soccer-screen
cd ~/soccer-screen
npm install
cp .env.example .env
nano .env
chmod +x start.sh
./start.sh
```

In another terminal, test Chromium kiosk mode:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

## Autostart on boot

Create a systemd service:

```bash
sudo nano /etc/systemd/system/soccer-screen.service
```

Paste:

```ini
[Unit]
Description=Football scoreboard local server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/pi/soccer-screen
ExecStart=/home/pi/soccer-screen/start.sh
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable soccer-screen
sudo systemctl start soccer-screen
```

For Chromium kiosk autostart on Raspberry Pi OS desktop:

```bash
mkdir -p ~/.config/lxsession/LXDE-pi
nano ~/.config/lxsession/LXDE-pi/autostart
```

Add:

```text
@xset s off
@xset -dpms
@xset s noblank
@chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

Reboot:

```bash
sudo reboot
```

After power loss, systemd restarts the local server and the desktop autostart opens Chromium back to the scoreboard.
