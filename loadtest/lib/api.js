import http from 'k6/http';

import { config } from './config.js';

// Every call the test makes, by the short id that thresholds and the summary use. The route is
// the k6 `name` tag, so URLs with different ids count as one endpoint.
export const ROUTES = {
  sign_in: 'POST /auth/v1/token?grant_type=password',
  refresh: 'POST /auth/v1/token?grant_type=refresh_token',
  event: 'GET /events/{eventId}',
  sub_events: 'GET /events/{eventId}/sub-events',
  album_page: 'GET /events/{eventId}/media',
  images: 'POST /events/{eventId}/media/images',
  uploaders: 'GET /events/{eventId}/media/uploaders',
  preflight: 'POST /events/{eventId}/media/preflight',
  complete: 'POST /media/{mediaId}/complete',
  r2_put: 'PUT <R2 presigned URL>',
};

// The endpoints our server answers. R2 PUTs go to Cloudflare, so they get no threshold.
export const SERVER_ENDPOINTS = [
  'sign_in',
  'event',
  'sub_events',
  'album_page',
  'images',
  'uploaders',
  'preflight',
  'complete',
];

function tags(ep, phase) {
  return { ep, name: ROUTES[ep], phase };
}

function authParams(token, ep, phase) {
  return {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    tags: tags(ep, phase),
  };
}

function authHeaders() {
  return { apikey: config.publishableKey, 'Content-Type': 'application/json' };
}

// Signs in with a password, as the app's sign-in screen does. Returns the session or null.
export function signIn(email, password, phase) {
  const res = http.post(
    `${config.baseUrl}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email, password }),
    { headers: authHeaders(), tags: tags('sign_in', phase) },
  );
  return res.status === 200 ? sessionFrom(res) : null;
}

export async function refreshSession(refreshToken, phase) {
  const res = await http.asyncRequest(
    'POST',
    `${config.baseUrl}/auth/v1/token?grant_type=refresh_token`,
    JSON.stringify({ refresh_token: refreshToken }),
    { headers: authHeaders(), tags: tags('refresh', phase) },
  );
  return res.status === 200 ? sessionFrom(res) : null;
}

function sessionFrom(res) {
  const body = res.json();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    userId: body.user.id,
    signedInAt: Date.now(),
  };
}

function path(eventId, rest = '') {
  return `${config.baseUrl}/events/${eventId}${rest}`;
}

function albumQuery(cursor, subEventId) {
  const parts = [];
  if (subEventId) parts.push(`subEventId=${encodeURIComponent(subEventId)}`);
  if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// The phone's calls. Each returns the k6 response; callers read `status` and `json()`.
export const phoneApi = {
  event: (token, eventId, phase) =>
    http.asyncRequest('GET', path(eventId), null, authParams(token, 'event', phase)),
  subEvents: (token, eventId, phase) =>
    http.asyncRequest(
      'GET',
      path(eventId, '/sub-events'),
      null,
      authParams(token, 'sub_events', phase),
    ),
  albumPage: (token, eventId, { cursor, subEventId }, phase) =>
    http.asyncRequest(
      'GET',
      path(eventId, `/media${albumQuery(cursor, subEventId)}`),
      null,
      authParams(token, 'album_page', phase),
    ),
  images: (token, eventId, mediaIds, phase) =>
    http.asyncRequest(
      'POST',
      path(eventId, '/media/images'),
      JSON.stringify({ mediaIds, size: 'thumbnail' }),
      authParams(token, 'images', phase),
    ),
  uploaders: (token, eventId, phase) =>
    http.asyncRequest(
      'GET',
      path(eventId, '/media/uploaders'),
      null,
      authParams(token, 'uploaders', phase),
    ),
};

// The upload calls. These run in their own scenario, one photo per iteration, so they block.
export const uploadApi = {
  preflight: (token, eventId, body, phase) =>
    http.post(
      path(eventId, '/media/preflight'),
      JSON.stringify(body),
      authParams(token, 'preflight', phase),
    ),
  put: (url, bytes, contentType, phase) =>
    http.put(url, bytes, { headers: { 'Content-Type': contentType }, tags: tags('r2_put', phase) }),
  complete: (token, mediaId, phase) =>
    http.post(
      `${config.baseUrl}/media/${mediaId}/complete`,
      null,
      authParams(token, 'complete', phase),
    ),
};
