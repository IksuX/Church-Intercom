// Interkom – sprawdzanie, czy transmisja jest PUBLICZNIE na żywo na YouTube / Facebooku.
// Web Presenter mówi tylko, że sygnał dociera do platformy (podgląd). „Start” na YouTube Studio / Facebook Live Producer
// widać dopiero w API platformy.
//
// YouTube: YouTube Data API v3, uprawnienie tylko do odczytu (youtube.readonly). Logowanie kodem na google.com/device
//   (klient OAuth typu „TV and Limited Input devices”) – nie wymaga domeny, działa też na mini PC w sieci lokalnej.
// Facebook: Graph API, token strony (Page access token) uzyskany z tokenu użytkownika z Graph API Explorer.
import { readJson, saveJson } from './config.js';

const LIVE_FB = new Set(['LIVE', 'LIVE_NOW']);
// adresy API (zmienne środowiskowe tylko do testów)
const G_OAUTH = process.env.IK_TEST_GOOGLE_OAUTH || 'https://oauth2.googleapis.com';
const YT_API = process.env.IK_TEST_YOUTUBE_API || 'https://www.googleapis.com/youtube/v3';
const FB_API = process.env.IK_TEST_FB_GRAPH || 'https://graph.facebook.com';

export class Platforms {
  constructor(secretsPath) {
    this.path = secretsPath;
    this.yt = { token: null, exp: 0, device: null, error: '' };
    this.fb = { error: '', pages: null, userToken: null };
    this.state = { youtube: { live: null, title: '', url: '', checked: 0 }, facebook: { live: null, title: '', url: '', checked: 0 } };
  }
  sec() { return readJson(this.path, {}); }
  save(patch) {
    const s = { ...this.sec(), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete s[k];
    saveJson(this.path, s);
  }

  configured(p) { const s = this.sec(); return p === 'youtube' ? !!s.ytRefresh : p === 'facebook' ? !!s.fbPageToken : false; }

  info() {
    const s = this.sec();
    return {
      youtube: { hasClient: !!(s.ytClientId && s.ytClientSecret), connected: !!s.ytRefresh, channel: s.ytChannel || '', error: this.yt.error,
        device: this.yt.device && Date.now() < this.yt.device.until ? { code: this.yt.device.user_code, url: this.yt.device.verification_url } : null, ...this.state.youtube },
      facebook: { hasApp: !!(s.fbAppId && s.fbAppSecret), connected: !!s.fbPageToken, page: s.fbPageName || '', pageId: s.fbPageId || '', error: this.fb.error,
        savedPages: (s.fbPages || []).length, hasUserToken: !!s.fbUserToken,
        pages: this.fb.pages ? this.fb.pages.map(({ id, name }) => ({ id, name })) : null, ...this.state.facebook },
    };
  }

  // ================= YOUTUBE =================
  async ytStart(clientId, clientSecret) {
    if (clientId && clientSecret) this.save({ ytClientId: clientId.trim(), ytClientSecret: clientSecret.trim() });
    const s = this.sec();
    if (!s.ytClientId || !s.ytClientSecret) throw new Error('Podaj Client ID i Client secret.');
    const r = await fetch(G_OAUTH + '/device/code', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: s.ytClientId, scope: 'https://www.googleapis.com/auth/youtube.readonly' }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error === 'invalid_client' ? 'Zły Client ID – klient musi być typu „TVs and Limited Input devices”.' : `Google: ${j.error_description || j.error || r.status}`);
    this.yt.device = { ...j, until: Date.now() + (j.expires_in || 1800) * 1000 };
    this.yt.error = '';
    this.ytPoll(j.device_code, Math.max(5, j.interval || 5));
    return { code: j.user_code, url: j.verification_url };
  }

  ytPoll(deviceCode, interval) {
    clearTimeout(this.yt.pollT);
    const tick = async () => {
      const d = this.yt.device;
      if (!d || d.device_code !== deviceCode || Date.now() > d.until) { if (d?.device_code === deviceCode) this.yt.device = null; return; }
      const s = this.sec();
      try {
        const r = await fetch(G_OAUTH + '/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: s.ytClientId, client_secret: s.ytClientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
          signal: AbortSignal.timeout(10000),
        });
        const j = await r.json().catch(() => ({}));
        if (j.error === 'authorization_pending') { this.yt.pollT = setTimeout(tick, interval * 1000); return; }
        if (j.error === 'slow_down') { interval += 5; this.yt.pollT = setTimeout(tick, interval * 1000); return; }
        if (!r.ok || !j.refresh_token) { this.yt.device = null; this.yt.error = j.error === 'access_denied' ? 'Odmówiono dostępu.' : `Google: ${j.error_description || j.error || r.status}`; return; }
        this.yt.token = j.access_token; this.yt.exp = Date.now() + (j.expires_in - 60) * 1000; this.yt.device = null;
        this.save({ ytRefresh: j.refresh_token });
        try {
          const ch = await this.ytGet('/channels?part=snippet&mine=true');
          this.save({ ytChannel: ch.items?.[0]?.snippet?.title || '' });
        } catch { /* nazwa kanału niekonieczna */ }
        console.log('[youtube] połączono kanał', this.sec().ytChannel || '');
      } catch { this.yt.pollT = setTimeout(tick, interval * 1000); }
    };
    this.yt.pollT = setTimeout(tick, interval * 1000);
  }

  async ytAccess() {
    if (this.yt.token && Date.now() < this.yt.exp) return this.yt.token;
    const s = this.sec();
    if (!s.ytRefresh) throw new Error('YouTube niepołączony');
    const r = await fetch(G_OAUTH + '/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: s.ytClientId, client_secret: s.ytClientSecret, refresh_token: s.ytRefresh, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error === 'invalid_grant' ? 'połączenie z YouTube wygasło – połącz ponownie w panelu' : `Google: ${j.error || r.status}`);
    this.yt.token = j.access_token; this.yt.exp = Date.now() + (j.expires_in - 60) * 1000;
    return this.yt.token;
  }

  async ytGet(pathQ) {
    const r = await fetch(YT_API + pathQ, { headers: { authorization: 'Bearer ' + await this.ytAccess() }, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`YouTube: ${j.error?.message || r.status}`);
    return j;
  }

  // Aktywna transmisja kanału: lifeCycleStatus „live” = publicznie, „testing” = podgląd w Studio
  async ytCheck() {
    const j = await this.ytGet('/liveBroadcasts?part=snippet,status&broadcastStatus=active&broadcastType=all&maxResults=5');
    const live = (j.items || []).find((b) => ['live', 'liveStarting'].includes(b.status?.lifeCycleStatus));
    return { live: !!live, title: live?.snippet?.title || '', url: live ? `https://youtu.be/${live.id}` : '' };
  }

  ytDisconnect() { this.yt = { token: null, exp: 0, device: null, error: '' }; this.save({ ytRefresh: null, ytChannel: null }); this.state.youtube = { live: null, title: '', url: '', checked: 0 }; }

  // ================= FACEBOOK =================
  // 1) App ID + App Secret + krótki token użytkownika (Graph API Explorer) → token długoterminowy → lista stron
  async fbConnect(appId, appSecret, userToken) {
    if (appId && appSecret) this.save({ fbAppId: appId.trim(), fbAppSecret: appSecret.trim() });
    const s = this.sec();
    if (!s.fbAppId || !s.fbAppSecret) throw new Error('Podaj App ID i App Secret.');
    if (!userToken) throw new Error('Wklej token użytkownika z Graph API Explorer.');
    const ex = await this.fbGet('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: s.fbAppId, client_secret: s.fbAppSecret, fb_exchange_token: userToken.trim() });
    // sprawdź uprawnienia od razu – bez pages_read_engagement nie da się odczytać transmisji strony
    try {
      const perms = await this.fbGet('/me/permissions', { access_token: ex.access_token });
      const granted = new Set((perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission));
      const missing = ['pages_show_list', 'pages_read_engagement'].filter((p) => !granted.has(p));
      if (missing.length) throw new Error(`Token nie ma uprawnień: ${missing.join(', ')}. Dodaj je w aplikacji Meta (Przypadki użycia → „Manage everything on your Page” → Dostosuj) i wygeneruj token ponownie w Graph API Explorer.`);
    } catch (e) { if (e.message.startsWith('Token nie ma')) throw e; }
    const pages = await this.fbGet('/me/accounts', { fields: 'id,name,access_token', limit: '100', access_token: ex.access_token });
    this.fb.pages = (pages.data || []).filter((p) => p.access_token);
    if (!this.fb.pages.length) throw new Error('Ten użytkownik nie zarządza żadną stroną (albo token nie ma uprawnień pages_show_list).');
    this.fb.error = '';
    // zapisujemy tokeny stron (nie wygasają) i token użytkownika (~60 dni) – zmiana strony bez ponownego wpisywania kluczy
    this.save({ fbUserToken: ex.access_token, fbPages: this.fb.pages.map(({ id, name, access_token }) => ({ id, name, access_token })) });
    return this.fb.pages.map(({ id, name }) => ({ id, name }));
  }
  // lista zapisanych stron; refresh = pobierz na nowo zapisanym tokenem użytkownika (np. nowa strona na koncie)
  async fbPagesList(refresh) {
    const s = this.sec();
    if (refresh) {
      if (!s.fbUserToken) throw new Error('Brak zapisanego tokenu użytkownika – wygeneruj nowy w Graph API Explorer.');
      try {
        const pages = await this.fbGet('/me/accounts', { fields: 'id,name,access_token', limit: '100', access_token: s.fbUserToken });
        const list = (pages.data || []).filter((p) => p.access_token).map(({ id, name, access_token }) => ({ id, name, access_token }));
        if (list.length) this.save({ fbPages: list });
      } catch (e) {
        if (/expired|session|#190/i.test(e.message)) { this.save({ fbUserToken: null }); throw new Error('Zapisany token użytkownika wygasł (po ok. 60 dniach) – wygeneruj nowy w Graph API Explorer. Zapisane strony nadal działają.'); }
        throw e;
      }
    }
    this.fb.pages = this.sec().fbPages || [];
    return this.fb.pages.map(({ id, name }) => ({ id, name }));
  }
  // 2) wybór strony – token strony z tokenu długoterminowego nie wygasa
  fbSelect(pageId) {
    const p = [...(this.fb.pages || []), ...(this.sec().fbPages || [])].find((x) => x.id === String(pageId));
    if (!p) throw new Error('Najpierw pobierz listę stron.');
    this.save({ fbPageId: p.id, fbPageName: p.name, fbPageToken: p.access_token });
    this.fb.pages = null;
    console.log('[facebook] połączono stronę', p.name);
  }
  async fbGet(pathQ, params) {
    const r = await fetch(FB_API + pathQ + '?' + new URLSearchParams(params), { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`Facebook: ${j.error?.message || r.status}`);
    return j;
  }
  // Dwie drogi: /live_videos (Live Video API – czasem wymaga weryfikacji aplikacji przez Meta)
  // albo /videos z polem live_status (wystarczy pages_read_engagement). Zapamiętujemy, która działa.
  async fbCheck() {
    const s = this.sec(), tok = s.fbPageToken;
    const norm = (v) => ({ status: v.status || v.live_status || '', title: v.title || v.description || '', permalink_url: v.permalink_url });
    const tries = {
      live: async () => (await this.fbGet(`/${s.fbPageId}/live_videos`, { fields: 'status,title,permalink_url', limit: '5', access_token: tok })).data || [],
      videos: async () => (await this.fbGet(`/${s.fbPageId}/videos`, { fields: 'live_status,title,description,permalink_url', limit: '5', access_token: tok })).data || [],
    };
    const order = this.fb.method === 'videos' ? ['videos', 'live'] : ['live', 'videos'];
    let data = null, err = null;
    for (const m of order) {
      try { data = await tries[m](); this.fb.method = m; break; } catch (e) { err ||= e; }
    }
    if (!data) {
      const msg = err?.message || '';
      if (/pages_read_engagement/.test(msg)) throw new Error('brak uprawnienia pages_read_engagement – dodaj je w aplikacji Meta, wygeneruj nowy token i połącz stronę ponownie');
      if (/#10\b|reviewed and approved/.test(msg)) throw new Error('Facebook wymaga, żeby token był wygenerowany przez osobę z rolą w aplikacji Meta (administrator/deweloper/tester), a aplikacja była w trybie deweloperskim');
      throw err;
    }
    const live = data.map(norm).find((v) => LIVE_FB.has(v.status));
    return { live: !!live, title: live?.title || '', url: live?.permalink_url ? `https://www.facebook.com${live.permalink_url}` : '' };
  }
  fbDisconnect() { this.fb = { error: '', pages: null }; this.save({ fbPageId: null, fbPageName: null, fbPageToken: null, fbPages: null, fbUserToken: null }); this.state.facebook = { live: null, title: '', url: '', checked: 0 }; }

  // ================= wspólne =================
  async check(p) {
    try {
      const r = p === 'youtube' ? await this.ytCheck() : await this.fbCheck();
      this.state[p] = { ...r, checked: Date.now(), error: '' };
      if (p === 'youtube') this.yt.error = ''; else this.fb.error = '';
    } catch (e) {
      this.state[p] = { ...this.state[p], checked: Date.now(), error: e.message };
      if (p === 'youtube') this.yt.error = e.message; else this.fb.error = e.message;
    }
    return this.state[p];
  }
}
export const PLATFORM_NAMES = { youtube: 'YouTube', facebook: 'Facebook' };
