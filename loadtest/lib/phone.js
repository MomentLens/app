import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

import { phoneApi, refreshSession } from './api.js';
import { APP, config, phaseAt, pick, randomBetween } from './config.js';

export const realtimeMetrics = {
  joinOk: new Rate('realtime_join_ok'),
  joinTime: new Trend('realtime_join_duration', true),
  serverCloses: new Counter('realtime_server_closes'),
  channelErrors: new Counter('realtime_channel_errors'),
  mediaMessages: new Counter('realtime_media_messages'),
  deliveryLag: new Trend('realtime_delivery_lag', true),
};
export const herdRefetches = new Counter('herd_refetches');
// A bug in this script, not a server failure. Any count fails the run so it is never mistaken
// for a result.
export const scriptErrors = new Counter('script_errors');

function ok(res) {
  return res.status >= 200 && res.status < 300;
}

// Realtime's commit_timestamp may carry microseconds, which not every Date parser reads.
function parseTimestamp(text) {
  if (typeof text !== 'string') return NaN;
  return Date.parse(text.replace(/(\.\d{3})\d+/, '$1'));
}

// One guest's phone with one event open, from sign-in to the end of the run. It makes the calls
// the event shell and Home tab make (src/app/(app)/event/[id]/), holds the Realtime channel from
// use-media-realtime.ts, and refetches the album on each change the way the app does. Resolves
// when the run's hold ends.
export function runPhone({ t0, session, event }) {
  const phone = new Phone(t0, session, event);
  return phone.run();
}

class Phone {
  constructor(t0, session, event) {
    this.t0 = t0;
    this.session = session;
    this.eventId = event.id;
    this.subEventIds = event.subEventIds;
    this.filter = undefined;
    // Loaded album pages in order: the cursor each was fetched with and the one it returned.
    this.pages = [];
    // Media id -> { version, at }, the thumbnails this phone has a signed URL for.
    this.signed = new Map();
    this.timers = new Set();
    this.stopping = false;
    this.ws = null;
    this.joinRef = 0;
    this.ref = 0;
    this.reconnectTries = 0;
    this.subscribedOnce = false;
    this.refetchTimer = null;
    this.firstPendingAt = null;
    this.refetching = false;
    this.refetchAgain = false;
    this.uploadersAt = 0;
    this.topic = `realtime:media:event:${this.eventId}:1`;
  }

  phase() {
    return phaseAt(this.t0);
  }

  later(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.stopping) this.guard(fn);
    }, ms);
    this.timers.add(id);
  }

  every(fn, ms) {
    const id = setInterval(() => {
      if (!this.stopping) this.guard(fn);
    }, ms);
    this.timers.add(id);
  }

  guard(fn) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        result.catch((error) => this.fail(error));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  fail(error) {
    scriptErrors.add(1, { phase: this.phase() });
    console.error(`phone ${this.session.userId}: ${error && error.stack ? error.stack : error}`);
  }

  run() {
    return new Promise((resolve) => {
      const endAt = this.t0 + config.endSeconds * 1000;
      this.later(
        () => {
          this.stopping = true;
          for (const id of this.timers) {
            clearTimeout(id);
            clearInterval(id);
          }
          this.timers.clear();
          if (this.ws) this.ws.close(1000);
          resolve();
        },
        Math.max(0, endAt - Date.now()),
      );
      if (config.realtime) this.connect();
      this.guard(() => this.openEvent());
      this.later(() => this.browse(), this.think());
      this.every(() => this.renewImages(), 60 * 1000);
      this.every(() => this.refreshToken(), 60 * 1000);
    });
  }

  think() {
    return randomBetween(config.thinkMinSeconds, config.thinkMaxSeconds) * 1000;
  }

  token() {
    return this.session.accessToken;
  }

  // The event layout and the Home tab mount these together.
  async openEvent() {
    const phase = this.phase();
    const [, , first] = await Promise.all([
      phoneApi.event(this.token(), this.eventId, phase),
      phoneApi.subEvents(this.token(), this.eventId, phase),
      this.loadPage(undefined),
      this.loadUploaders(),
    ]);
    if (first) {
      this.pages = [first];
      await this.signMissing();
    }
  }

  async loadPage(cursor) {
    const res = await phoneApi.albumPage(
      this.token(),
      this.eventId,
      { cursor, subEventId: this.filter },
      this.phase(),
    );
    if (!ok(res)) return null;
    const body = res.json();
    return {
      cursor,
      nextCursor: body.nextCursor,
      media: body.media.map((item) => ({ id: item.id, version: item.variantVersion })),
    };
  }

  // useThumbnailMap: one call per batch of 50 loaded photos, asking only for ids with no URL yet,
  // a changed variant_version, or a URL older than 45 minutes.
  async signMissing() {
    const now = Date.now();
    const missing = [];
    for (const page of this.pages) {
      for (const item of page.media) {
        const entry = this.signed.get(item.id);
        if (!entry || entry.version !== item.version || now - entry.at >= APP.renewImagesMs) {
          missing.push(item);
        }
      }
    }
    const calls = [];
    for (let i = 0; i < missing.length; i += APP.imagesBatch) {
      const batch = missing.slice(i, i + APP.imagesBatch);
      calls.push(
        phoneApi
          .images(
            this.token(),
            this.eventId,
            batch.map((item) => item.id),
            this.phase(),
          )
          .then((res) => {
            if (!ok(res)) return;
            for (const item of batch) this.signed.set(item.id, { version: item.version, at: now });
          }),
      );
    }
    await Promise.all(calls);
  }

  // A return to the app after the phone was locked. The event and sub-event queries refetch on
  // focus, the album refetches on AppState 'active' (use-media-realtime.ts), and the uploaders
  // list refetches once its 60 s staleTime has passed.
  async foreground() {
    const phase = this.phase();
    const calls = [
      phoneApi.event(this.token(), this.eventId, phase),
      phoneApi.subEvents(this.token(), this.eventId, phase),
      this.refetchPages().then(() => this.signMissing()),
    ];
    if (Date.now() - this.uploadersAt >= 60 * 1000) calls.push(this.loadUploaders());
    await Promise.all(calls);
  }

  async loadUploaders() {
    this.uploadersAt = Date.now();
    await phoneApi.uploaders(this.token(), this.eventId, this.phase());
  }

  // One action every THINK_MIN to THINK_MAX seconds: a return to the app, a scroll to the next
  // page, or at the end of the album a sub-event chip or a pull to refresh.
  async browse() {
    const last = this.pages[this.pages.length - 1];
    if (Math.random() < config.foregroundShare) {
      await this.foreground();
    } else if (last && last.nextCursor) {
      const page = await this.loadPage(last.nextCursor);
      if (page) this.pages.push(page);
    } else if (Math.random() < 0.5 && this.subEventIds.length > 0) {
      this.filter = this.filter ? undefined : pick(this.subEventIds);
      const first = await this.loadPage(undefined);
      this.pages = first ? [first] : [];
    } else {
      await this.refetchPages();
    }
    await this.signMissing();
    this.later(() => this.browse(), this.think());
  }

  // TanStack Query refetches an infinite query's loaded pages one after another, each with the
  // cursor the page before it returned.
  async refetchPages() {
    const count = Math.max(1, this.pages.length);
    const pages = [];
    let cursor;
    for (let i = 0; i < count; i += 1) {
      const page = await this.loadPage(cursor);
      if (!page) break;
      pages.push(page);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (pages.length) this.pages = pages;
  }

  async renewImages() {
    await this.signMissing();
  }

  async refreshToken() {
    if (Date.now() - this.session.signedInAt < APP.refreshTokenMs) return;
    const next = await refreshSession(this.session.refreshToken, this.phase());
    if (!next) return;
    this.session = next;
    // realtime-js sends the new token to every joined channel.
    if (this.ws && this.joined) {
      this.send([
        String(this.joinRef),
        this.nextRef(),
        this.topic,
        'access_token',
        {
          access_token: next.accessToken,
        },
      ]);
    }
  }

  // use-media-realtime.ts refetchAlbum, debounced as the app does: once changes pause for 1 s,
  // and at least every 4 s while they keep coming.
  scheduleRefetch() {
    const now = Date.now();
    if (this.firstPendingAt === null) this.firstPendingAt = now;
    if (this.refetchTimer !== null) {
      clearTimeout(this.refetchTimer);
      this.timers.delete(this.refetchTimer);
    }
    const wait = Math.max(0, Math.min(APP.quietMs, this.firstPendingAt + APP.maxWaitMs - now));
    const id = setTimeout(() => {
      this.timers.delete(id);
      this.refetchTimer = null;
      this.firstPendingAt = null;
      if (!this.stopping) this.guard(() => this.refetchAlbum());
    }, wait);
    this.refetchTimer = id;
    this.timers.add(id);
  }

  // Invalidating ['album', eventId] and ['uploaders', eventId] refetches the loaded album pages
  // and the uploaders list, and the thumbnail map then signs the new photos. The Admin's album
  // status query is not mounted on a Guest's phone, so it is not called.
  async refetchAlbum() {
    if (this.refetching) {
      this.refetchAgain = true;
      return;
    }
    this.refetching = true;
    herdRefetches.add(1, { phase: this.phase() });
    try {
      await Promise.all([this.refetchPages().then(() => this.signMissing()), this.loadUploaders()]);
    } finally {
      this.refetching = false;
    }
    if (this.refetchAgain && !this.stopping) {
      this.refetchAgain = false;
      await this.refetchAlbum();
    }
  }

  nextRef() {
    this.ref += 1;
    return String(this.ref);
  }

  send(message) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  // Phoenix protocol vsn 2.0.0, as realtime-js 2.116.0 speaks it: every message is a JSON array
  // [join_ref, ref, topic, event, payload].
  connect() {
    const url = `${config.wsUrl}/realtime/v1/websocket?apikey=${encodeURIComponent(
      config.publishableKey,
    )}&vsn=2.0.0`;
    const ws = new WebSocket(url, null, { tags: { ep: 'realtime', phase: this.phase() } });
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.joined = false;
    let heartbeat = null;

    ws.addEventListener('open', () => {
      this.join();
      heartbeat = setInterval(() => {
        this.send([null, this.nextRef(), 'phoenix', 'heartbeat', {}]);
      }, APP.heartbeatMs);
      this.timers.add(heartbeat);
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      this.guard(() => this.onMessage(JSON.parse(event.data)));
    });

    // A socket error always ends in a close, which is counted below, so the error itself is not.

    ws.addEventListener('close', (event) => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        this.timers.delete(heartbeat);
      }
      if (this.stopping || this.ws !== ws) return;
      realtimeMetrics.serverCloses.add(1, {
        phase: this.phase(),
        code: String(event && event.code !== undefined ? event.code : 'none'),
      });
      this.reconnect();
    });
  }

  reconnect() {
    this.reconnectTries += 1;
    const delay = APP.reconnectMs[this.reconnectTries - 1] || 10000;
    this.later(() => this.connect(), delay);
  }

  join() {
    this.joinRef += 1;
    const ref = String(this.joinRef);
    this.joinStartedAt = Date.now();
    this.pendingJoin = ref;
    this.send([
      ref,
      ref,
      this.topic,
      'phx_join',
      {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: '', enabled: false },
          postgres_changes: [
            { event: '*', schema: 'public', table: 'media', filter: `event_id=eq.${this.eventId}` },
            { event: '*', schema: 'public', table: 'event', filter: `id=eq.${this.eventId}` },
          ],
          private: false,
        },
        access_token: this.token(),
      },
    ]);
  }

  onMessage([, ref, topic, event, payload]) {
    if (topic !== this.topic) return;
    const phase = this.phase();
    if (event === 'phx_reply' && ref === this.pendingJoin) {
      this.pendingJoin = null;
      const joined = payload && payload.status === 'ok';
      realtimeMetrics.joinOk.add(joined, { phase });
      if (!joined) {
        realtimeMetrics.channelErrors.add(1, { phase, reason: 'join_refused' });
        console.warn(`join refused: ${JSON.stringify(payload).slice(0, 300)}`);
        return;
      }
      realtimeMetrics.joinTime.add(Date.now() - this.joinStartedAt, { phase });
      this.joined = true;
      this.reconnectTries = 0;
      // A rejoin after a dropped connection may have missed changes, so the app refetches.
      if (this.subscribedOnce) {
        this.guard(() => this.refetchAlbum());
        this.guard(() => phoneApi.event(this.token(), this.eventId, phase));
      }
      this.subscribedOnce = true;
      return;
    }
    if (event === 'system' && payload && payload.status === 'error') {
      realtimeMetrics.channelErrors.add(1, { phase, reason: 'system' });
      console.warn(`system error: ${JSON.stringify(payload).slice(0, 300)}`);
      return;
    }
    if (event === 'phx_error' || event === 'phx_close') {
      realtimeMetrics.channelErrors.add(1, { phase, reason: event });
      this.joined = false;
      if (!this.stopping) {
        this.reconnectTries += 1;
        this.later(() => this.join(), APP.reconnectMs[this.reconnectTries - 1] || 10000);
      }
      return;
    }
    if (event === 'postgres_changes' && payload && payload.data) {
      const { table, commit_timestamp: committedAt, type } = payload.data;
      if (table === 'media') {
        realtimeMetrics.mediaMessages.add(1, { phase, type: String(type) });
        const lag = Date.now() - parseTimestamp(committedAt);
        if (Number.isFinite(lag)) realtimeMetrics.deliveryLag.add(lag, { phase });
        this.scheduleRefetch();
      } else if (table === 'event') {
        // recheckEvent: the event query refetches.
        this.guard(() => phoneApi.event(this.token(), this.eventId, phase));
      }
    }
  }
}
