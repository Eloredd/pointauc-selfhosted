/**
 * Pointauc-compatible mini-backend for self-hosted auctions.
 *
 * Implements the subset of the Pointauc Client API that the open-source
 * frontend needs to run a Twitch auction:
 *   - Twitch OAuth login (authorization code -> session cookie `userSession`)
 *   - /api/user, /api/app and a few settings stubs
 *   - Overlays CRUD + role tokens (for OBS browser sources)
 *   - socket.io namespaces: global, /broadcasting (overlay push), per-integration
 *     namespaces that emit `Bid` events
 *   - Twitch channel-points redemptions -> bids (via Helix polling)
 *   - Twitch chat `!bid` commands -> bids (anonymous IRC, no registration needed)
 *
 * The frontend is served from the same origin, so no CORS setup is required.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server as SocketServer } from 'socket.io';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8000);
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const DA_CLIENT_ID = process.env.DA_CLIENT_ID || '';
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || '';
const CHAT_BID_COMMAND = (process.env.CHAT_BID_COMMAND || '!bid').trim().toLowerCase();
const REWARD_PREFIX = process.env.REWARD_PREFIX || '';
const FRONTEND_DIST = process.env.FRONTEND_DIST
  || [path.join(__dirname, 'public'), path.join(__dirname, '..', '..', 'pointauc_frontend', 'dist')]
    .find((p) => fs.existsSync(path.join(p, 'index.html')))
  || path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'sessions.json');
const REAL_TWITCH = Boolean(CLIENT_ID && CLIENT_SECRET);

const HELIX = 'https://api.twitch.tv/helix';

// ---------------------------------------------------------------------------
// Session store (in-memory + best-effort JSON persistence)
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionToken -> session
const overlayTokens = new Map(); // role/custom token -> sessionToken
const sessionsByUser = new Map(); // twitchId|username -> session

const loadSessions = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const user of raw.users ?? []) {
      const { loginTokens = [], ...session } = user;
      sessionsByUser.set(session.userKey, session);
      for (const token of loginTokens) sessions.set(token, session);
      for (const t of Object.values(session.tokens ?? {})) overlayTokens.set(t, loginTokens[0]);
      for (const t of session.customTokens ?? []) overlayTokens.set(t.token, loginTokens[0]);
      session.rewards = new Map(session.rewardsSerialized ?? []);
    }
    console.log(`[store] loaded ${sessionsByUser.size} user session(s)`);
  } catch {
    /* first run */
  }
};

const saveSessions = () => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const users = [...new Set(sessions.values())].map((session) => ({
      ...session,
      rewardsSerialized: [...(session.rewards ?? new Map())],
      loginTokens: [...sessions.entries()].filter(([, s]) => s === session).map(([t]) => t),
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users }));
  } catch (e) {
    console.warn('[store] save failed:', e.message);
  }
};

const uuid = () => crypto.randomUUID();

const createSession = ({ username, twitchId, accessToken, refreshToken }) => {
  const userKey = twitchId || `guest:${username.toLowerCase()}`;
  let session = sessionsByUser.get(userKey);
  if (!session) {
    session = {
      userKey,
      userId: twitchId || uuid(),
      username,
      twitchId: twitchId || null,
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      overlays: [],
      tokens: {}, // role -> token
      customTokens: [],
      broadcast: {}, // dataType -> last payload
      rewardPrefix: REWARD_PREFIX,
      rewards: new Map(), // rewardId -> { title, cost }  (not persisted)
      seenRedemptions: [], // ring of processed redemption ids
      listenedKeys: [],
      chatConnected: false,
      createdAt: Date.now(),
    };
    sessionsByUser.set(userKey, session);
  }
  session.accessToken = accessToken || session.accessToken;
  session.refreshToken = refreshToken || session.refreshToken;
  session.username = username || session.username;
  const token = uuid();
  sessions.set(token, session);
  // housekeeping: keep at most 5 concurrent login tokens per user
  const userTokens = [...sessions.entries()].filter(([, s]) => s === session);
  if (userTokens.length > 5) {
    for (const [st] of userTokens.slice(0, userTokens.length - 5)) sessions.delete(st);
  }
  return { session, token };
};

const rememberRedemption = (session, id) => {
  session.seenRedemptions.push(id);
  if (session.seenRedemptions.length > 500) session.seenRedemptions.shift();
};

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
// Behind reverse proxies (Railway, Cloudflare Tunnel, HF Spaces) TLS ends at the
// proxy — trust X-Forwarded-* so req.protocol is https and OAuth redirect_uri
// is built with the correct scheme.
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

if (process.env.REQUEST_LOG) {
  app.use((req, res, next) => {
    res.on('finish', () => console.log(`[req] ${req.method} ${req.path} -> ${res.statusCode}`));
    next();
  });
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => {
        const i = v.indexOf('=');
        return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
      }),
  );

const getSessionFromRequest = (req) => {
  const token = parseCookies(req.headers.cookie).userSession;
  return token ? sessions.get(token) ?? null : null;
};

const requireSession = (req, res, next) => {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ message: 'Unauthorized' });
  req.session = session;
  next();
};

const publicOrigin = (req) => `${req.protocol}://${req.get('host')}`;

// ---------------------------------------------------------------------------
// Twitch Helix helpers
// ---------------------------------------------------------------------------

const helixFetch = async (session, urlPath, options = {}) => {
  const res = await fetch(`${HELIX}${urlPath}`, {
    ...options,
    headers: {
      'Client-Id': CLIENT_ID,
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Error('Twitch token expired/invalid — re-login required');
  if (!res.ok) throw new Error(`Helix ${urlPath} -> ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
};

const helixRefreshToken = async (session) => {
  if (!session.refreshToken) return false;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
  if (!res.ok) return false;
  const data = await res.json();
  session.accessToken = data.access_token;
  session.refreshToken = data.refresh_token;
  saveSessions();
  return true;
};

// ---------------------------------------------------------------------------
// Auth / user endpoints
// ---------------------------------------------------------------------------

app.post('/api/twitch/auth', async (req, res) => {
  const { code } = req.body ?? {};

  if (REAL_TWITCH && code) {
    try {
      const redirectUri = `${publicOrigin(req)}/twitch/redirect`;
      const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const token = await tokenRes.json();

      const usersRes = await fetch(`${HELIX}/users`, {
        headers: { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${token.access_token}` },
      });
      const users = await usersRes.json();
      const user = users?.data?.[0];
      if (!user) throw new Error('helix /users returned no user');

      const { session, token: sessionToken } = createSession({
        username: user.display_name || user.login,
        twitchId: user.id,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
      });
      res.setHeader('Set-Cookie', `userSession=${sessionToken}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
      console.log(`[auth] logged in: ${session.username} (${session.twitchId})`);
      return res.json({ isNew: false });
    } catch (e) {
      console.error('[auth] twitch exchange failed:', e.message);
      return res.status(400).json({ message: e.message });
    }
  }

  // Guest mode: no Twitch app configured — mint a local session.
  const { session, token: sessionToken } = createSession({ username: 'streamer' });
  res.setHeader('Set-Cookie', `userSession=${sessionToken}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  console.log(`[auth] guest session created (${session.username})`);
  return res.json({ isNew: false });
});

app.get('/api/app', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/random/integer', (_req, res) => res.json({ value: crypto.randomInt(0, 1_000_000) }));

app.get('/api/user', requireSession, (req, res) => {
  const { session } = req;
  const authDto = (data, extra = {}) =>
    data ? { isValid: true, username: data.username ?? session.username, id: data.id ?? session.userId, ...extra } : undefined;
  res.json({
    userId: session.userId,
    activeSettingsPresetId: 'default',
    twitchAuth: authDto(
      { username: session.username, id: session.twitchId || session.userId },
      { accessToken: session.accessToken ?? undefined, socketConnectionToken: 'selfhosted' },
    ),
    daAuth: session.da ? authDto(session.da, { accessToken: session.da.accessToken, socketConnectionToken: session.da.socketConnectionToken }) : undefined,
    donatePayAuth: session.donatePayRu ? authDto({ username: 'DonatePay', id: session.donatePayRu.userId ?? session.userId }, { accessToken: session.donatePayRu.accessToken }) : undefined,
    donatePayEuAuth: session.donatePayEu ? authDto({ username: 'DonatePay EU', id: session.donatePayEu.userId ?? session.userId }, { accessToken: session.donatePayEu.accessToken }) : undefined,
  });
});

// ---------------------------------------------------------------------------
// DonationAlerts OAuth (frontend connects to DA Centrifuge itself using the
// socketConnectionToken we return from /api/user)
// ---------------------------------------------------------------------------

// Debug: remembers the exact reason of the last failed DA auth so it can be
// fetched from a deployed instance without access to its console logs.
let lastDaAuthError = null;

app.post('/api/da/auth', async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    lastDaAuthError = 'no valid session (401): userSession cookie is missing or was wiped by a redeploy — log in via Twitch first, then connect DA';
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.session = session;
  const { code } = req.body ?? {};
  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
    return res.status(400).json({ message: 'DonationAlerts app is not configured: set DA_CLIENT_ID and DA_CLIENT_SECRET' });
  }
  try {
    const tokenRes = await fetch('https://www.donationalerts.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DA_CLIENT_ID,
        client_secret: DA_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${publicOrigin(req)}/da/redirect`,
      }),
    });
    if (!tokenRes.ok) {
      lastDaAuthError = `token exchange ${tokenRes.status}: ${await tokenRes.text().catch(() => '')}`;
      throw new Error(`DA token exchange failed: ${tokenRes.status}`);
    }
    const token = await tokenRes.json();

    const userRes = await fetch('https://www.donationalerts.com/api/v1/user/oauth', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) {
      lastDaAuthError = `user fetch ${userRes.status}: ${await userRes.text().catch(() => '')}`;
      throw new Error(`DA user fetch failed: ${userRes.status}`);
    }
    const userData = (await userRes.json()).data ?? {};
    if (!userData.socket_connection_token) throw new Error('DA response has no socket_connection_token');

    req.session.da = {
      id: String(userData.id ?? ''),
      username: userData.name ?? 'DonationAlerts',
      accessToken: token.access_token,
      socketConnectionToken: userData.socket_connection_token,
    };
    saveSessions();
    lastDaAuthError = null;
    console.log(`[auth] DonationAlerts connected: ${req.session.da.username}`);
    res.json({});
  } catch (e) {
    console.error('[auth] DA failed:', e.message);
    res.status(400).json({ message: e.message });
  }
});

app.get('/debug/last-da-error', (_req, res) => res.json({ lastDaAuthError }));

app.post('/api/da/centrifuge/subscribe', requireSession, (_req, res) => res.json({}));

app.post('/api/donatePay/auth', requireSession, (req, res) => {
  const { accessToken } = req.body ?? {};
  if (!accessToken) return res.status(400).json({ message: 'accessToken required' });
  req.session.donatePayRu = { accessToken, userId: req.body?.userId };
  saveSessions();
  res.json({});
});

app.post('/api/donatePayEu/auth', requireSession, (req, res) => {
  const { accessToken } = req.body ?? {};
  if (!accessToken) return res.status(400).json({ message: 'accessToken required' });
  req.session.donatePayEu = { accessToken, userId: req.body?.userId };
  saveSessions();
  res.json({});
});

// no-op stubs for integrations the self-hosted build does not support
const noopAuth = (_req, res) => res.json({});
app.post('/api/tourniquet/auth', requireSession, noopAuth);
app.post('/api/tourniquet/webhook', (_req, res) => res.json({}));
app.post('/api/ihaq/auth', requireSession, noopAuth);
app.post('/api/donateHelper/auth', requireSession, noopAuth);
app.post('/api/kick/auth/state', requireSession, noopAuth);
app.post('/api/kick/auth', requireSession, noopAuth);
app.post('/api/vkVideoLive/auth', requireSession, noopAuth);

app.get('/api/username', requireSession, (req, res) => res.json({ username: req.session.username }));
app.put('/api/user/settings', requireSession, (_req, res) => res.json({}));
app.get('/api/user/integration/validate', requireSession, (_req, res) => res.json({ twitchAuth: true }));
app.get('/api/aucSettings', requireSession, (_req, res) => res.json({}));
app.get('/api/audioRoom/user', requireSession, (_req, res) => res.json({}));
app.get('/api/audioRoom/presets', requireSession, (_req, res) => res.json([]));
app.get('/api/oldUsers/hasUser', requireSession, (_req, res) => res.json({ hasUser: false }));

// ---------------------------------------------------------------------------
// Role / custom tokens (used by overlays and the public API)
// ---------------------------------------------------------------------------

const tokenPayload = (token, role, session) => ({
  token,
  tokenId: uuid(),
  role,
  permissions: role === 'overlay' ? ['overlay'] : ['public-api'],
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
  createdAt: new Date().toISOString(),
  // extra: username is used by the UI to build overlay links
  username: session.username,
});

const findSessionToken = (session) => {
  for (const [st, s] of sessions.entries()) if (s === session) return st;
  return null;
};

app.get('/api/oshino/token', requireSession, (req, res) => {
  const token = req.session.tokens.api ?? req.session.tokens.overlay ?? uuid();
  res.json({ token });
});

// The frontend prefixes auth routes with /api (dev proxy flattens them); register both.
const roleTokenHandler = (req, res) => {
  const role = req.params.role;
  let token = req.session.tokens[role];
  if (!token) {
    token = uuid();
    req.session.tokens[role] = token;
    overlayTokens.set(token, findSessionToken(req.session));
    saveSessions();
  }
  res.json(tokenPayload(token, role, req.session));
};
const roleRevokeHandler = (req, res) => {
  const token = req.session.tokens[req.params.role];
  if (token) overlayTokens.delete(token);
  delete req.session.tokens[req.params.role];
  saveSessions();
  res.json({});
};
const listTokensHandler = (req, res) => {
  const custom = (req.session.customTokens ?? []).map((t) => t.token);
  res.json({ tokens: [...Object.values(req.session.tokens), ...custom].map((t) => ({ token: t })) });
};
const createCustomTokenHandler = (req, res) => {
  const token = uuid();
  req.session.customTokens = [...(req.session.customTokens ?? []), { token, name: req.body?.name ?? 'custom' }];
  overlayTokens.set(token, findSessionToken(req.session));
  saveSessions();
  res.json(tokenPayload(token, 'custom', req.session));
};
const tokenInfoHandler = (req, res) => {
  const sessionToken = findSessionToken(req.session);
  const custom = (req.session.customTokens ?? []).find((t) => t.token === sessionToken);
  res.json(tokenPayload(sessionToken, custom ? 'custom' : 'session', req.session));
};

for (const prefix of ['/auth', '/api/auth']) {
  app.get(`${prefix}/tokens/role/:role`, requireSession, roleTokenHandler);
  app.delete(`${prefix}/tokens/role/:role`, requireSession, roleRevokeHandler);
  app.post(`${prefix}/tokens/role/:role/refresh`, requireSession, roleTokenHandler);
  app.get(`${prefix}/tokens`, requireSession, listTokensHandler);
  app.post(`${prefix}/tokens/custom`, requireSession, createCustomTokenHandler);
  app.get(`${prefix}/tokens/info`, requireSession, tokenInfoHandler);
}

// ---------------------------------------------------------------------------
// Overlays CRUD
// ---------------------------------------------------------------------------

const findOverlay = (session, id) => session.overlays.find((o) => o.id === id);

app.get('/api/overlays', requireSession, (req, res) => res.json(req.session.overlays));

app.post('/api/overlays', requireSession, (req, res) => {
  const now = new Date().toISOString();
  const overlay = {
    id: uuid(),
    name: req.body?.name ?? 'Overlay',
    type: req.body?.type ?? 'Auction',
    settings: req.body?.settings ?? {},
    canvasResolution: req.body?.canvasResolution ?? { width: 1920, height: 1080 },
    transform: req.body?.transform ?? null,
    createdAt: now,
    updatedAt: now,
  };
  req.session.overlays.push(overlay);
  saveSessions();
  res.json(overlay);
});

app.get('/api/overlays/:id', (req, res) => {
  const session = getSessionFromRequest(req);
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const resolved =
    session ??
    (bearer && overlayTokens.get(bearer) ? sessions.get(overlayTokens.get(bearer)) : null);
  if (!resolved) return res.status(401).json({ message: 'Unauthorized' });
  const overlay = findOverlay(resolved, req.params.id);
  if (!overlay) return res.status(404).json({ message: 'Not found' });
  res.json(overlay);
});

const replaceOverlay = (req, res) => {
  const overlay = findOverlay(req.session, req.params.id);
  if (!overlay) return res.status(404).json({ message: 'Not found' });
  const { id, createdAt, ...body } = req.body ?? {};
  Object.keys(overlay).forEach((k) => {
    if (k in body) overlay[k] = body[k];
  });
  overlay.updatedAt = new Date().toISOString();
  saveSessions();
  emitDataUpdate(req.session, `overlays:${overlay.id}`, overlay);
  res.json(overlay);
};

app.patch('/api/overlays/:id', (req, res) => replaceOverlay(req, res));
app.put('/api/overlays/:id', (req, res) => replaceOverlay(req, res));
app.delete('/api/overlays/:id', requireSession, (req, res) => {
  req.session.overlays = req.session.overlays.filter((o) => o.id !== req.params.id);
  saveSessions();
  res.json({});
});

// ---------------------------------------------------------------------------
// Broadcast endpoints (streamer browser -> overlays)
// ---------------------------------------------------------------------------

const emitDataUpdate = (session, dataType, data) => {
  io.of('/broadcasting')
    .to(`session:${session.userKey}`)
    .emit('dataUpdate', { dataType, data });
};

const BROADCAST_TYPES = ['lots', 'timer', 'wheel', 'rules'];

for (const type of BROADCAST_TYPES) {
  app.post(`/api/broadcast/${type}`, requireSession, (req, res) => {
    req.session.broadcast[type] = req.body?.data ?? null;
    emitDataUpdate(req.session, type, req.body?.data);
    if (type === 'lots') void syncLotRewards(req.session, req.body?.data ?? []);
    res.json({});
  });
}

// ---------------------------------------------------------------------------
// Twitch rewards <-> lots sync + redemption polling (REAL mode only)
// ---------------------------------------------------------------------------

const bootTime = Date.now();

const syncLotRewards = async (session, lots) => {
  if (!REAL_TWITCH || !session.accessToken || !session.twitchId) return;
  try {
    const existing = await helixFetch(
      session,
      `/channel_points/custom_rewards?broadcaster_id=${session.twitchId}`,
    );
    const byTitle = new Map(existing.data.map((r) => [r.title, r]));
    const wantedTitles = new Set();

    for (const lot of lots.slice(0, 50)) {
      const title = `${session.rewardPrefix}${lot.name}`.slice(0, 21);
      wantedTitles.add(title);
      let reward = byTitle.get(title);
      if (!reward) {
        const created = await helixFetch(session, `/channel_points/custom_rewards`, {
          method: 'POST',
          body: JSON.stringify({
            title,
            cost: Math.max(1, Number(lot.amount) || 1),
            is_enabled: true,
            is_user_input_required: false,
            is_global_cooldown_enabled: false,
            should_redemptions_skip_request_queue: true,
          }),
        });
        reward = created.data[0];
        console.log(`[rewards] created "${title}" (cost ${reward.cost})`);
      } else if (reward.cost !== Math.max(1, Number(lot.amount) || 1)) {
        await helixFetch(
          session,
          `/channel_points/custom_rewards?id=${reward.id}&broadcaster_id=${session.twitchId}`,
          { method: 'PATCH', body: JSON.stringify({ cost: Math.max(1, Number(lot.amount) || 1) }) },
        );
        reward.cost = Math.max(1, Number(lot.amount) || 1);
      }
      session.rewards.set(reward.id, { title, cost: reward.cost });
    }

    // disable rewards that no longer have lots
    for (const [id, info] of session.rewards) {
      if (!wantedTitles.has(info.title)) {
        await helixFetch(
          session,
          `/channel_points/custom_rewards?id=${id}&broadcaster_id=${session.twitchId}`,
          { method: 'PATCH', body: JSON.stringify({ is_enabled: false }) },
        ).catch(() => {});
        session.rewards.delete(id);
      }
    }
  } catch (e) {
    console.warn('[rewards] sync failed:', e.message);
  }
};

app.delete('/twitch/rewards', requireSession, async (req, res) => {
  if (REAL_TWITCH && req.session.twitchId) {
    for (const [id] of req.session.rewards) {
      await helixFetch(
        req.session,
        `/channel_points/custom_rewards?id=${id}&broadcaster_id=${req.session.twitchId}`,
        { method: 'DELETE' },
      ).catch(() => {});
    }
  }
  req.session.rewards.clear();
  res.json({});
});

app.patch('/twitch/redemptions', requireSession, async (req, res) => {
  const { rewardId, redemptionId, status } = req.body ?? {};
  if (REAL_TWITCH && req.session.twitchId && rewardId && redemptionId) {
    await helixFetch(
      req.session,
      `/channel_points/redemptions?id=${redemptionId}&broadcaster_id=${req.session.twitchId}&reward_id=${rewardId}`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
    ).catch((e) => console.warn('[redemptions] patch failed:', e.message));
  }
  res.json({});
});

app.patch('/twitch/redemptions/batch', requireSession, async (req, res) => {
  const { rewards, status } = req.body ?? {};
  if (REAL_TWITCH && req.session.twitchId && Array.isArray(rewards)) {
    for (const { rewardId, redemptions } of rewards) {
      for (const redemptionId of redemptions) {
        await helixFetch(
          req.session,
          `/channel_points/redemptions?id=${redemptionId}&broadcaster_id=${req.session.twitchId}&reward_id=${rewardId}`,
          { method: 'PATCH', body: JSON.stringify({ status }) },
        ).catch(() => {});
      }
    }
  }
  res.json({});
});

const pollRedemptions = async (session, namespace) => {
  if (!REAL_TWITCH || !session.accessToken || !session.twitchId) return;
  try {
    const data = await helixFetch(
      session,
      `/channel_points/redemptions?broadcaster_id=${session.twitchId}&status=UNFULFILLED&sort=OLDEST&first=50`,
    );
    for (const r of data.data ?? []) {
      if (session.seenRedemptions.includes(r.id)) continue;
      rememberRedemption(session, r.id);
      if (new Date(r.redeemed_at).getTime() < bootTime) continue; // pre-restart redemption
      const bid = {
        id: r.id,
        timestamp: r.redeemed_at,
        username: r.user_name,
        cost: r.reward.cost,
        color: '#9147ff',
        message: r.reward.title.replace(session.rewardPrefix, ''),
        rewardId: r.reward.id,
      };
      console.log(`[bids] ${bid.username} -> ${bid.cost} pts ("${bid.message}")`);
      namespace.to(`session:${session.userKey}`).emit('Bid', bid);
    }
  } catch (e) {
    if (e.message.includes('401') && (await helixRefreshToken(session))) return;
    console.warn('[bids] poll failed:', e.message);
  }
};

// ---------------------------------------------------------------------------
// Twitch chat bids (anonymous IRC — works in guest mode too)
// ---------------------------------------------------------------------------

const chatSockets = new Map(); // userKey -> ws
const chatDiagnostics = new Map(); // userKey -> live IRC diagnostics (see /debug/chat-status)

const startChatListener = (session, namespace) => {
  if (chatSockets.has(session.userKey)) return;
  const channel = (session.twitchId ? session.username : process.env.CHAT_CHANNEL || session.username)
    .trim()
    .replace(/^#/, '')
    .toLowerCase();

  const diag = {
    channel,
    connectedAt: null,
    closedAt: null,
    ircLines: [],
    privmsgCount: 0,
    bidCount: 0,
    lastError: null,
  };
  chatDiagnostics.set(session.userKey, diag);

  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  chatSockets.set(session.userKey, ws);
  session.chatConnected = true;

  ws.on('open', () => {
    diag.connectedAt = new Date().toISOString();
    // Capability names must be fully qualified per Twitch docs, shorthand
    // `:tags` gets NAK'd and message tags are lost.
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send(`NICK justinfan${crypto.randomInt(10000, 99999)}`);
  });
  ws.on('message', (raw) => {
    for (const line of raw.toString().split('\r\n')) {
      if (line) {
        diag.ircLines.push(line.slice(0, 160));
        if (diag.ircLines.length > 12) diag.ircLines.shift();
      }
      if (line.startsWith('PING')) {
        ws.send('PONG :tmi.twitch.tv');
        continue;
      }
      // per Twitch docs: join only after the welcome (001) line
      if (line.includes(' 001 ')) {
        ws.send(`JOIN #${channel}`);
        console.log(`[chat] listening #${channel} for ${CHAT_BID_COMMAND} commands`);
        continue;
      }
      const match = /^(?:@([^ ]+) )?:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/.exec(line);
      if (!match) continue;
      diag.privmsgCount++;
      const [, tagsRaw, login, text] = match;
      const tags = Object.fromEntries(
        tagsRaw.split(';').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
      );
      const rest = text.slice(CHAT_BID_COMMAND.length).trim();
      if (text.toLowerCase().startsWith(CHAT_BID_COMMAND) && rest) {
        // `!bid <lot name> <amount>`  |  `!bid <amount>`
        const amountMatch = /(\d[\d\s.,]*)(k)?\s*$/i.exec(rest);
        if (!amountMatch) continue;
        let amount = Number(amountMatch[1].replace(/[\s,]/g, '')) * (amountMatch[2] ? 1000 : 1);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        amount = Math.round(amount);
        const lotName = rest.slice(0, rest.length - amountMatch[0].length).trim();
        const bid = {
          id: `chat-${tags.id ?? uuid()}`,
          timestamp: new Date().toISOString(),
          username: tags['display-name'] || login,
          cost: amount,
          color: tags.color || '#22c55e',
          message: lotName, // empty -> unassigned bid the streamer can route manually
        };
        console.log(`[chat] ${bid.username} -> ${bid.cost} pts ${lotName ? `("${lotName}")` : '(unassigned)'}`);
        diag.bidCount++;
        namespace.to(`session:${session.userKey}`).emit('Bid', bid);
      }
    }
  });
  ws.on('error', (e) => {
    diag.lastError = e.message;
    console.warn('[chat] error:', e.message);
  });
  ws.on('close', () => {
    diag.closedAt = new Date().toISOString();
    chatSockets.delete(session.userKey);
    session.chatConnected = false;
    // self-heal: bring the listener back while the auction page is still open
    setTimeout(() => {
      if (namespace.sockets.size > 0 && !chatSockets.has(session.userKey)) {
        startChatListener(session, namespace);
      }
    }, 5000);
  });
};

app.get('/debug/chat-status', (_req, res) => res.json({
  command: CHAT_BID_COMMAND,
  listeners: [...chatDiagnostics.entries()].map(([userKey, d]) => ({
    userKey,
    ...d,
    ircConnected: chatSockets.has(userKey),
    ircReadyState: chatSockets.get(userKey)?.readyState ?? null,
  })),
}));

const stopChatListener = (session) => {
  const ws = chatSockets.get(session.userKey);
  if (ws) ws.close();
  chatSockets.delete(session.userKey);
  session.chatConnected = false;
};

// ---------------------------------------------------------------------------
// socket.io
// ---------------------------------------------------------------------------

const io = new SocketServer(app.listen(PORT, () => console.log(`[server] http://localhost:${PORT} (dist: ${FRONTEND_DIST})`)), {
  cors: { origin: true, credentials: true },
});

const sessionFromHandshake = (socket) => {
  const cookieToken = parseCookies(socket.handshake.headers.cookie ?? '').userSession
    ?? socket.handshake.query?.cookie;
  const bearer = socket.handshake.auth?.token;
  const sessionToken =
    (cookieToken && sessions.get(cookieToken) ? cookieToken : null)
    ?? (bearer && overlayTokens.get(bearer) ? overlayTokens.get(bearer) : null);
  return sessionToken ? sessions.get(sessionToken) : null;
};

// --- /broadcasting: overlays subscribe; the streamer's browser pushes data ---
io.of('/broadcasting').on('connection', (socket) => {
  const session = sessionFromHandshake(socket);
  if (!session) {
    console.warn('[broadcasting] connection rejected: no session');
    return socket.disconnect(true);
  }
  console.log(`[broadcasting] connected (${session.username})`);
  const isStreamer = Boolean(parseCookies(socket.handshake.headers.cookie ?? '').userSession
    && sessions.get(parseCookies(socket.handshake.headers.cookie ?? '').userSession) === session);
  socket.join(`session:${session.userKey}`);

  if (isStreamer) {
    session.listenedKeys = session.listenedKeys ?? [];
    // a freshly (re)connected streamer page should push data for active overlays
    setTimeout(() => {
      for (const dataType of session.listenedKeys) {
        socket.emit('updatesRequested', { dataType });
      }
    }, 1500);
  }

  socket.on('listen', (dataTypes = []) => {
    if (!Array.isArray(dataTypes)) return;
    for (const dataType of dataTypes) {
      socket.emit('dataUpdate', { dataType, data: session.broadcast[dataType] ?? null });
      if (isStreamer) continue;
      if (!session.listenedKeys.includes(dataType)) session.listenedKeys.push(dataType);
      // ask the streamer's browser for fresh data
      io.of('/broadcasting').to(`session:${session.userKey}`).emit('updatesRequested', { dataType });
    }
  });

  socket.on('unlisten', (dataTypes = []) => {
    if (!Array.isArray(dataTypes)) return;
    session.listenedKeys = (session.listenedKeys ?? []).filter((k) => !dataTypes.includes(k));
  });

  socket.on('updatesSilenced', (dataTypes = []) => {
    if (isStreamer) return;
    for (const dataType of dataTypes) {
      io.of('/broadcasting').to(`session:${session.userKey}`).emit('updatesSilenced', { dataType });
    }
  });
});

// --- per-integration namespaces: the source of `Bid` events -----------------
const INTEGRATION_NAMESPACES = ['twitch', 'da', 'donatePay', 'donatePayEu', 'kick', 'vkVideoLive', 'tourniquet', 'ihaq', 'donateHelper'];
const pollers = new Map(); // userKey -> interval

for (const ns of INTEGRATION_NAMESPACES) {
  const namespace = io.of(`/${ns}`);
  namespace.on('connection', (socket) => {
    const session = sessionFromHandshake(socket);
    if (!session) return socket.disconnect(true);
    socket.join(`session:${session.userKey}`);

    socket.on('bidsSubscribe', () => {
      socket.emit('bidsStateChange', { state: true });
      if (ns !== 'twitch') return;
      if (REAL_TWITCH && !pollers.has(session.userKey)) {
        pollers.set(session.userKey, setInterval(() => pollRedemptions(session, namespace), 3000));
        console.log(`[bids] redemption polling started for ${session.username}`);
      }
      startChatListener(session, namespace);
    });

    socket.on('bidsUnsubscribe', () => {
      socket.emit('bidsStateChange', { state: false });
    });

    socket.on('disconnect', () => {
      if (namespace.sockets.size === 0) {
        const p = pollers.get(session.userKey);
        if (p) clearInterval(p);
        pollers.delete(session.userKey);
        stopChatListener(session);
      }
    });
  });
}

// global namespace: public-api clients (no server-initiated events needed)
io.on('connection', (socket) => {
  const session = sessionFromHandshake(socket);
  if (session) socket.join(`session:${session.userKey}`);
});

// ---------------------------------------------------------------------------
// Debug / test helpers — inactive unless DEBUG_KEY is set in the environment
// ---------------------------------------------------------------------------

const debugBidHandler = (req, res) => {
  const key = process.env.DEBUG_KEY;
  const supplied = req.get('x-debug-key') || req.query.key;
  if (!key || supplied !== key) return res.status(404).json({ message: 'Not found' });
  const { username = 'test-user', cost = 100, message = '' } = { ...req.query, ...req.body };
  const bid = {
    id: `debug-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    username: String(username),
    cost: Number(cost) || 100,
    color: '#22c55e',
    message: String(message),
  };
  for (const session of new Set(sessions.values())) {
    io.of('/twitch').to(`session:${session.userKey}`).emit('Bid', bid);
  }
  res.json({ ok: true, bid });
};
app.get('/debug/bid', debugBidHandler);
app.post('/debug/bid', debugBidHandler);

// ---------------------------------------------------------------------------
// Static frontend (SPA fallback) — must be last
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/socket.io')) {
    console.warn(`[missing] ${req.method} ${req.path}`);
    if (!res.headersSent) return res.status(404).json({ message: 'Not implemented in self-hosted backend' });
  }
  next();
});

// Runtime configuration for the frontend (Twitch/DA OAuth client ids) is
// injected into index.html so client ids can be changed without a rebuild.
const renderIndexHtml = (_req, res) => {
  const config = {
    TWITCH_CLIENT_ID: CLIENT_ID || undefined,
    DA_CLIENT_ID: DA_CLIENT_ID || undefined,
  };
  const html = fs
    .readFileSync(path.join(FRONTEND_DIST, 'index.html'), 'utf8')
    .replace('<head>', `<head><script>window.__POINTAUC_CONFIG__=${JSON.stringify(config)};</script>`);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
};

app.get('/', renderIndexHtml);
app.use(express.static(FRONTEND_DIST, { index: false }));
app.get('*', renderIndexHtml);

loadSessions();
