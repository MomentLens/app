import {
  ApproveRequestsResponse,
  BlockRequestResponse,
  ListPendingRequestsResponse,
  RejectRequestsResponse,
  BlockAttendeeResponse,
  CancelJoinRequestResponse,
  ChangeAttendeeRoleResponse,
  CreateCoverUploadResponse,
  CreateEventResponse,
  ErrorResponse,
  GetEventResponse,
  GetEventSettingsResponse,
  HealthResponse,
  JoinEventResponse,
  ListEventsResponse,
  ListAttendeesResponse,
  ListSubEventsResponse,
  ProfileResponse,
  MediaStatusResponse,
  MediaStatusRequest,
  ResolveInviteResponse,
  RemoveAttendeeResponse,
  SetEventCoverResponse,
  UpdateEventSettingsResponse,
  type AddSubEventRequest,
  type ApproveRequestsRequest,
  type BlockRequestRequest,
  type ListPendingRequestsRequest,
  type RejectRequestsRequest,
  type BlockAttendeeRequest,
  type ChangeAttendeeRoleRequest,
  type CreateEventRequest,
  type ErrorCode,
  type JoinEventRequest,
  type ListAttendeesRequest,
  type RemoveAttendeeRequest,
  type ResolveInviteRequest,
  type UpdateEventSettingsRequest,
  type UpdateSubEventRequest,
} from '@momentlens/shared-types';
import {
  isAuthApiError,
  isAuthRefreshDiscardedError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

// The app's one typed client for the MomentLens API (Handbook §4). Every body is parsed against
// its shared schema before a screen sees it, so a contract mismatch arrives as an error here
// rather than as undefined fields in the UI.

// Read with dot notation on purpose. Expo inlines EXPO_PUBLIC_ variables at build time only when
// they are referenced this way, never through destructuring or brackets.
export const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Longer than the API's own 3-second database timeout plus a slow mobile round trip.
const REQUEST_TIMEOUT_MS = 10_000;

const AUTH_UNREACHABLE = 'Could not reach Supabase Auth to refresh the session.';

export class ApiError extends Error {
  readonly status: number | undefined;
  // The ErrorResponse code, when the body carried one this build knows. A screen switches on it,
  // or on `status` when it is missing (Handbook §5.3).
  readonly code: ErrorCode | undefined;
  // True when the request went out and no answer came within REQUEST_TIMEOUT_MS. A write may have
  // landed anyway, which a request that never reached the API cannot have.
  readonly timedOut: boolean;

  constructor(message: string, status?: number, code?: ErrorCode, timedOut = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.timedOut = timedOut;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  method?: Method;
  // Sent as JSON. A request without one sends no body and no Content-Type.
  body?: unknown;
  signal?: AbortSignal;
}

async function request(
  path: string,
  { method = 'GET', body, signal }: RequestOptions = {},
  accessToken?: string,
) {
  if (!API_URL) {
    throw new ApiError('EXPO_PUBLIC_API_URL is not set. Add it to apps/mobile/.env, then reload.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (accessToken !== undefined) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  try {
    return await fetch(`${API_URL.replace(/\/+$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // The caller cancelled, for example because the screen went away. TanStack Query expects the
    // abort itself back, not a failure it would show or retry.
    if (signal?.aborted) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new ApiError(
        `The API did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
        undefined,
        undefined,
        true,
      );
    }
    throw new ApiError('Could not reach the API. Check the connection and the API address.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

// The signed-in user's access token. getSession refreshes it first when it is within 90 seconds of
// expiring, so the API rarely sees an expired one.
async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (data.session) {
    return data.session.access_token;
  }
  // Offline with an expired token: the session is still stored and still good, it just cannot be
  // refreshed yet. Nobody is logged out for that (D-109).
  if (isAuthRetryableFetchError(error)) {
    throw new ApiError(AUTH_UNREACHABLE);
  }
  throw new ApiError('Nobody is signed in.', 401, 'no_session');
}

// True when Supabase answered the refresh and refused it: a 4xx other than a rate limit, the same
// rule the API applies to access tokens (apps/api/src/middleware/auth.ts). A 5xx, a 429 or a
// network failure says nothing about the token.
function refreshWasRejected(error: unknown): boolean {
  if (!isAuthApiError(error)) {
    return false;
  }
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}

// After a 401, a fresh access token for the one retry, or an ApiError.
async function refreshedAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.refreshSession();
  if (data.session) {
    return data.session.access_token;
  }
  if (refreshWasRejected(error)) {
    // The session is dead, the one case that shows Forced Logout (D-109). auth-js removes the
    // session itself only once the access token has also expired, so it is signed out here for
    // the other case. The SIGNED_OUT that follows shows Forced Logout (features/auth/session.ts).
    await supabase.auth.signOut({ scope: 'local' });
    throw new ApiError('Supabase rejected the refresh token.', 401, 'no_session');
  }
  if (isAuthRefreshDiscardedError(error)) {
    // Another refresh or a sign-out changed the stored session while this refresh was in flight.
    // Whatever it left is the current answer.
    return accessToken();
  }
  if (isAuthRetryableFetchError(error)) {
    throw new ApiError(AUTH_UNREACHABLE);
  }
  throw new ApiError('Nobody is signed in.', 401, 'no_session');
}

// A request on behalf of the signed-in user. On a 401 it refreshes the session once and retries
// once (D-109), with the same method and body, so a create retried here carries the same
// requestId. A second 401 goes back to the caller as it stands: Supabase accepted the refresh,
// so the session is alive and nobody is logged out for it (S-01 card, decided at build mobile).
async function authenticatedRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const first = await request(path, options, await accessToken());
  if (first.status !== 401) {
    return first;
  }
  return request(path, options, await refreshedAccessToken());
}

// A request that works with or without a session (D-115). Nobody signed in sends no header. A
// stored session sends its token and gets the same one refresh and retry as above. A session that
// cannot be refreshed offline throws rather than asking as signed out, because the answer would
// then miss the caller's membership and route them wrong.
async function optionallyAuthenticatedRequest(
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const { data, error } = await supabase.auth.getSession();
  if (data.session === null) {
    if (isAuthRetryableFetchError(error)) {
      throw new ApiError(AUTH_UNREACHABLE);
    }
    return request(path, options);
  }
  const first = await request(path, options, data.session.access_token);
  if (first.status !== 401) {
    return first;
  }
  return request(path, options, await refreshedAccessToken());
}

// A body that is not ErrorResponse still says what kind of failure it was through its status. So
// does one with a code this build has never heard of (packages/shared-types errors.ts).
async function errorFrom(what: string, response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = ErrorResponse.safeParse(body);
  return new ApiError(
    `${what} answered HTTP ${response.status}.`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function parseBody<T>(what: string, response: Response, schema: Schema<T>): Promise<T> {
  // A captive portal on venue WiFi can answer 200 with an HTML page, so JSON is not assumed.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`${what} answered with something other than JSON.`, response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      `${what} answered with a body this app does not understand.`,
      response.status,
    );
  }
  return parsed.data;
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await request('/health', { signal });
  // 503 is an answer, not a failure. The API is up and reporting that the database is not.
  if (response.status !== 200 && response.status !== 503) {
    throw await errorFrom('GET /health', response);
  }
  return parseBody('GET /health', response, HealthResponse);
}

// The caller's own profile (D-109).
export async function getMyProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  const response = await authenticatedRequest('/profiles/me', { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /profiles/me', response);
  }
  return parseBody('GET /profiles/me', response, ProfileResponse);
}

// Creates the event, its venues, its sub-events and the caller's Admin membership (D-110). A 201
// is a new event and a 200 is the first one again, because this wizard's requestId repeated; the
// app treats both the same. There is deliberately no signal: a create the screen stops waiting
// for may still land, and the retry with the same requestId is what finds it.
export async function createEvent(body: CreateEventRequest): Promise<CreateEventResponse> {
  const response = await authenticatedRequest('/events', { method: 'POST', body });
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('POST /events', response);
  }
  return parseBody('POST /events', response, CreateEventResponse);
}

// Every event where the caller's membership is active (D-110), in no promised order.
export async function listEvents(signal?: AbortSignal): Promise<ListEventsResponse> {
  const response = await authenticatedRequest('/events', { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events', response);
  }
  return parseBody('GET /events', response, ListEventsResponse);
}

// One event and the caller's role in it, for the Event shell (D-118). A caller who is not an active
// member gets 403 not_member, and a deleted or unknown event 404 not_found.
export async function getEvent(eventId: string, signal?: AbortSignal): Promise<GetEventResponse> {
  const path = `/events/${encodeURIComponent(eventId)}`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}', response);
  }
  return parseBody('GET /events/{eventId}', response, GetEventResponse);
}

// A presigned PUT for a new cover, for the event's Admin only. The API builds the key; the app
// gets an uploadId and a URL, and never sees the key (root invariant 12).
export async function createCoverUpload(eventId: string): Promise<CreateCoverUploadResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/cover-upload`;
  const response = await authenticatedRequest(path, { method: 'POST' });
  if (response.status !== 200) {
    throw await errorFrom('POST /events/{eventId}/cover-upload', response);
  }
  return parseBody('POST /events/{eventId}/cover-upload', response, CreateCoverUploadResponse);
}

// Sets the cover once its upload has reached R2. Only the uploadId goes back (root invariant 12).
export async function setEventCover(
  eventId: string,
  uploadId: string,
): Promise<SetEventCoverResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/cover`;
  const response = await authenticatedRequest(path, { method: 'PUT', body: { uploadId } });
  if (response.status !== 200) {
    throw await errorFrom('PUT /events/{eventId}/cover', response);
  }
  return parseBody('PUT /events/{eventId}/cover', response, SetEventCoverResponse);
}

// The Event Settings form's fields and the requests a switch to auto would admit, for the event's
// Admin only (D-142). Anyone else gets 403 not_member or wrong_role, and a deleted or unknown event
// 404 not_found.
export async function getEventSettings(
  eventId: string,
  signal?: AbortSignal,
): Promise<GetEventSettingsResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/settings`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}/settings', response);
  }
  return parseBody('GET /events/{eventId}/settings', response, GetEventSettingsResponse);
}

// Changes the fields the body carries and nothing else, and answers with the settings after the
// write and how many pending requests a switch to auto let in (D-142). No signal, for the reason
// createEvent has none: a PATCH the screen stops waiting for may still land.
export async function updateEventSettings(
  eventId: string,
  body: UpdateEventSettingsRequest,
): Promise<UpdateEventSettingsResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/settings`;
  const response = await authenticatedRequest(path, { method: 'PATCH', body });
  if (response.status !== 200) {
    throw await errorFrom('PATCH /events/{eventId}/settings', response);
  }
  return parseBody('PATCH /events/{eventId}/settings', response, UpdateEventSettingsResponse);
}

export async function listAttendees(
  eventId: string,
  filters: ListAttendeesRequest = {},
  signal?: AbortSignal,
): Promise<ListAttendeesResponse> {
  const query = Object.entries(filters)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const path = `/events/${encodeURIComponent(eventId)}/attendees${query ? `?${query}` : ''}`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) throw await errorFrom('GET attendees', response);
  return parseBody('GET attendees', response, ListAttendeesResponse);
}

export async function changeAttendeeRole(
  eventId: string,
  userId: string,
  body: ChangeAttendeeRoleRequest,
): Promise<ChangeAttendeeRoleResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(userId)}/role`;
  const response = await authenticatedRequest(path, {
    method: 'PATCH',
    body,
  });
  if (response.status !== 200) throw await errorFrom('PATCH attendee role', response);
  return parseBody('PATCH attendee role', response, ChangeAttendeeRoleResponse);
}

export async function removeAttendee(
  eventId: string,
  userId: string,
  body: RemoveAttendeeRequest,
): Promise<RemoveAttendeeResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(userId)}/remove`;
  const response = await authenticatedRequest(path, {
    method: 'POST',
    body,
  });
  if (response.status !== 200) throw await errorFrom('POST attendee remove', response);
  return parseBody('POST attendee remove', response, RemoveAttendeeResponse);
}

export async function blockAttendee(
  eventId: string,
  userId: string,
  body: BlockAttendeeRequest,
): Promise<BlockAttendeeResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(userId)}/block`;
  const response = await authenticatedRequest(path, {
    method: 'POST',
    body,
  });
  if (response.status !== 200) throw await errorFrom('POST attendee block', response);
  return parseBody('POST attendee block', response, BlockAttendeeResponse);
}

export async function listPendingRequests(
  eventId: string,
  { cursor }: ListPendingRequestsRequest = {},
  signal?: AbortSignal,
): Promise<ListPendingRequestsResponse> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  const response = await authenticatedRequest(
    `/events/${encodeURIComponent(eventId)}/join-requests${query}`,
    { signal },
  );
  if (response.status !== 200) throw await errorFrom('GET join requests', response);
  return parseBody('GET join requests', response, ListPendingRequestsResponse);
}

export async function approveRequests(
  eventId: string,
  body: ApproveRequestsRequest,
): Promise<ApproveRequestsResponse> {
  const response = await authenticatedRequest(
    `/events/${encodeURIComponent(eventId)}/join-requests/approve`,
    { method: 'POST', body },
  );
  if (response.status !== 200) throw await errorFrom('POST approve requests', response);
  return parseBody('POST approve requests', response, ApproveRequestsResponse);
}

export async function rejectRequests(
  eventId: string,
  body: RejectRequestsRequest,
): Promise<RejectRequestsResponse> {
  const response = await authenticatedRequest(
    `/events/${encodeURIComponent(eventId)}/join-requests/reject`,
    { method: 'POST', body },
  );
  if (response.status !== 200) throw await errorFrom('POST reject requests', response);
  return parseBody('POST reject requests', response, RejectRequestsResponse);
}

export async function blockRequest(
  eventId: string,
  userId: string,
  body: BlockRequestRequest,
): Promise<BlockRequestResponse> {
  const response = await authenticatedRequest(
    `/events/${encodeURIComponent(eventId)}/join-requests/${encodeURIComponent(userId)}/block`,
    { method: 'POST', body },
  );
  if (response.status !== 200) throw await errorFrom('POST block request', response);
  return parseBody('POST block request', response, BlockRequestResponse);
}

// The event an invite previews, and the caller's own membership when someone is signed in
// (D-115). A dead invite is a 404 not_found. The token or code goes in the body, never the path,
// because nginx logs every path (arch:invite).
export async function resolveInvite(
  body: ResolveInviteRequest,
  signal?: AbortSignal,
): Promise<ResolveInviteResponse> {
  const response = await optionallyAuthenticatedRequest('/invites/resolve', {
    method: 'POST',
    body,
    signal,
  });
  if (response.status !== 200) {
    throw await errorFrom('POST /invites/resolve', response);
  }
  return parseBody('POST /invites/resolve', response, ResolveInviteResponse);
}

// Joins through the invite Join Confirmation showed, active or pending by the event's approval
// mode (arch:membership). A 201 made the caller's row and a 200 found it, and the app treats both
// the same: a repeat returns the row unchanged, so a retry after a timeout is safe. No signal, for
// the reason createEvent has none.
export async function joinEvent(body: JoinEventRequest): Promise<JoinEventResponse> {
  const response = await authenticatedRequest('/invites/join', { method: 'POST', body });
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('POST /invites/join', response);
  }
  return parseBody('POST /invites/join', response, JoinEventResponse);
}

// Cancel Request. The API deletes the caller's row only while it is pending and answers with what
// they hold afterwards: null once the request is gone, or the active row when an approve got there
// first (arch:membership).
export async function cancelJoinRequest(eventId: string): Promise<CancelJoinRequestResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/join-request`;
  const response = await authenticatedRequest(path, { method: 'DELETE' });
  if (response.status !== 200) {
    throw await errorFrom('DELETE /events/{eventId}/join-request', response);
  }
  return parseBody('DELETE /events/{eventId}/join-request', response, CancelJoinRequestResponse);
}

// The event's schedule, for every active role (D-121): 1 to 15 sub-events by start, then end, then
// id. A caller who is not an active member gets 403 not_member, and a deleted or unknown event 404
// not_found, as GET /events/{eventId} answers.
export async function listSubEvents(
  eventId: string,
  signal?: AbortSignal,
): Promise<ListSubEventsResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/sub-events`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}/sub-events', response);
  }
  return parseBody('GET /events/{eventId}/sub-events', response, ListSubEventsResponse);
}

// Adds a sub-event, for the event's Admin. A 201 added it and a 200 found the sheet's requestId
// already used, and both answer with the schedule after the write. No signal, for the reason
// createEvent has none: an add the screen stops waiting for may still land.
export async function addSubEvent(
  eventId: string,
  body: AddSubEventRequest,
): Promise<ListSubEventsResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/sub-events`;
  const response = await authenticatedRequest(path, { method: 'POST', body });
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('POST /events/{eventId}/sub-events', response);
  }
  return parseBody('POST /events/{eventId}/sub-events', response, ListSubEventsResponse);
}

// An edit or a Delay, which the server cannot tell apart: the body carries only what changes, as
// absolute values, so a retry changes nothing more (D-121). Answers with the schedule.
export async function updateSubEvent(
  subEventId: string,
  body: UpdateSubEventRequest,
): Promise<ListSubEventsResponse> {
  const path = `/sub-events/${encodeURIComponent(subEventId)}`;
  const response = await authenticatedRequest(path, { method: 'PATCH', body });
  if (response.status !== 200) {
    throw await errorFrom('PATCH /sub-events/{subEventId}', response);
  }
  return parseBody('PATCH /sub-events/{subEventId}', response, ListSubEventsResponse);
}

// Deletes a sub-event and, in the same transaction, its venue if nothing else uses it (D-121).
// The event's last one is 409 last_sub_event. A sub-event already gone is 404 not_found, which a
// retry of a delete that landed also gets.
export async function deleteSubEvent(subEventId: string): Promise<ListSubEventsResponse> {
  const path = `/sub-events/${encodeURIComponent(subEventId)}`;
  const response = await authenticatedRequest(path, { method: 'DELETE' });
  if (response.status !== 200) {
    throw await errorFrom('DELETE /sub-events/{subEventId}', response);
  }
  return parseBody('DELETE /sub-events/{subEventId}', response, ListSubEventsResponse);
}

// S-10 reads only publish metadata. Local thumbnails never go through this endpoint (D-145).
export async function getMediaStatus(
  eventId: string,
  body: MediaStatusRequest,
  signal?: AbortSignal,
): Promise<MediaStatusResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/media/status`;
  const response = await authenticatedRequest(path, {
    method: 'POST',
    body: MediaStatusRequest.parse(body),
    signal,
  });
  if (response.status !== 200)
    throw await errorFrom('POST /events/{eventId}/media/status', response);
  return parseBody('POST /events/{eventId}/media/status', response, MediaStatusResponse);
}
