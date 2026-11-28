import {
  AcceptConsentResponse,
  AlbumStatusResponse,
  ApproveRequestsResponse,
  BlockRequestResponse,
  ListPendingRequestsResponse,
  ListReferencesResponse,
  RejectRequestsResponse,
  BlockAttendeeResponse,
  CancelJoinRequestResponse,
  ChangeAttendeeRoleResponse,
  CreateAvatarUploadResponse,
  CreateCoverUploadResponse,
  CreateReferenceUploadResponse,
  CreateEventResponse,
  DeleteMediaResponse,
  ErrorResponse,
  GetEventResponse,
  GetEventSettingsResponse,
  FlagPhotoResponse,
  KeepBlurRegionResponse,
  KeepPhotoFlagsResponse,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsResponse,
  ForceVerifyAttendeeResponse,
  HealthResponse,
  JoinEventResponse,
  ListAlbumResponse,
  ListBlurRegionsResponse,
  ListEventsResponse,
  ListAttendeesResponse,
  ListInvitesResponse,
  ListSubEventsResponse,
  ListUploadersResponse,
  MediaDetailResponse,
  MediaImagesResponse,
  ProfileResponse,
  MediaStatusResponse,
  CompleteUploadResponse,
  PreflightUploadResponse,
  RegenerateInviteResponse,
  ListVenueQrsResponse,
  RegenerateVenueQrResponse,
  ResolveInviteResponse,
  RemoveAttendeeResponse,
  SetAlbumResponse,
  SetAvatarResponse,
  SetEventCoverResponse,
  UpdateEventSettingsResponse,
  type AcceptConsentRequest,
  type AddBlurRegionRequest,
  type AddSubEventRequest,
  type ApproveRequestsRequest,
  type BlockRequestRequest,
  type ListAlbumRequest,
  type ListPendingRequestsRequest,
  type RejectRequestsRequest,
  type BlockAttendeeRequest,
  type ChangeAttendeeRoleRequest,
  type CreateEventRequest,
  type ErrorCode,
  type ForceVerifyAttendeeRequest,
  type JoinEventRequest,
  type ListAttendeesRequest,
  type ListFlaggedPhotosRequest,
  type ListReviewBlurRegionsRequest,
  type MediaImagesRequest,
  type MediaStatusRequest,
  type PreflightUploadRequest,
  type RemoveAttendeeRequest,
  type RegenerateInviteRequest,
  type RegenerateVenueQrRequest,
  type ResolveInviteRequest,
  type SetAlbumRequest,
  type UpdateEventSettingsRequest,
  type UpdateSubEventRequest,
} from '@momentlens/shared-types';
import {
  isAuthApiError,
  isAuthRefreshDiscardedError,
  isAuthRetryableFetchError,
  type Session,
} from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';
import { setServiceUnavailable, useServiceStore } from '@/stores/service';

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

// Thrown before a queued photo's request goes out under another account's session, and before
// the retry after a 401 when the refresh brought back another account. The upload queue leaves
// the photo as it was (D-146). Without it, completion under the next account answers 403
// not_uploader, which stops the first account's photo for good.
export class AccountChangedError extends Error {
  constructor() {
    super('Another account is signed in. The queued photo waits for its own account.');
    this.name = 'AccountChangedError';
  }
}

// The error a caller's abort produces when it lands before the request goes out, shaped like the
// one fetch rejects with. RN's AbortSignal polyfill has no `reason` to throw instead.
function abortError(): Error {
  return Object.assign(new Error('The request was cancelled before it was sent.'), {
    name: 'AbortError',
  });
}

// The one GET /health in flight after a failure, if any.
let checkingService: { owner: string; promise: Promise<void> } | null = null;

// A 500 cannot say that Supabase is down, so after one, and after a Supabase Auth call that answers
// 5xx, the app asks GET /health (hb §5.3, D-161). A 503 with `database: error` shows Supabase
// Unavailable. Any other answer, or none, leaves the failure to the screen that drew it. One check
// runs at a time, none while the screen already shows, and none for a caller who is not signed in,
// since the screen covers only the signed-in app.
function checkService(): void {
  const { userId: owner, status } = useAuthStore.getState();
  if (
    owner === null ||
    status !== 'signedIn' ||
    checkingService?.owner === owner ||
    useServiceStore.getState().unavailable
  )
    return;
  const check = { owner, promise: Promise.resolve() };
  checkingService = check;
  check.promise = readHealth()
    .then(({ httpStatus, health }) => {
      if (
        useAuthStore.getState().userId === owner &&
        httpStatus === 503 &&
        health.database === 'error'
      )
        setServiceUnavailable(true);
    })
    .catch(() => undefined)
    .finally(() => {
      if (checkingService === check) checkingService = null;
    });
}

// A Supabase Auth call that Supabase answered with a 5xx. auth-js reports a 502, 503 or 504 as a
// retryable fetch error and any other 5xx as an API error, and a network failure as a retryable
// fetch error with status 0, which says nothing about the project.
function authServerFailed(error: unknown): boolean {
  return (isAuthApiError(error) || isAuthRetryableFetchError(error)) && error.status >= 500;
}

// Passes an answer through, asking GET /health first when it is a 500.
function checked(response: Response): Response {
  if (response.status === 500) checkService();
  return response;
}

// Supabase Unavailable's Try Again: GET /health again. `up` clears the screen. Throws ApiError when
// the API cannot be reached at all.
export async function recheckService(): Promise<'up' | 'down'> {
  const owner = useAuthStore.getState().userId;
  const { httpStatus, health } = await readHealth();
  if (httpStatus !== 200 || health.database !== 'ok') return 'down';
  if (useAuthStore.getState().userId === owner) setServiceUnavailable(false);
  return 'up';
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
  // An abort that landed while the token lookup or refresh was pending. A listener added to an
  // aborted signal never fires, so without this the request would go out anyway (D-158).
  if (signal?.aborted) {
    throw abortError();
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

// A session's token, or AccountChangedError when the request belongs to another account.
function tokenFor(session: Session, owner: string | undefined): string {
  if (owner !== undefined && session.user.id !== owner) {
    throw new AccountChangedError();
  }
  return session.access_token;
}

// The signed-in user's access token. getSession refreshes it first when it is within 90 seconds of
// expiring, so the API rarely sees an expired one. With an owner, only that account's token.
async function accessToken(owner?: string): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (data.session) {
    return tokenFor(data.session, owner);
  }
  if (authServerFailed(error)) {
    checkService();
    throw new ApiError(AUTH_UNREACHABLE);
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
async function refreshedAccessToken(owner?: string): Promise<string> {
  const { data, error } = await supabase.auth.refreshSession();
  if (data.session) {
    return tokenFor(data.session, owner);
  }
  if (authServerFailed(error)) {
    checkService();
    throw new ApiError(AUTH_UNREACHABLE);
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
    return accessToken(owner);
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
//
// With an owner, the request goes out only under that account's session (D-146).
async function authenticatedRequest(
  path: string,
  options: RequestOptions = {},
  owner?: string,
): Promise<Response> {
  const first = await request(path, options, await accessToken(owner));
  if (first.status !== 401) {
    return checked(first);
  }
  // A cancelled caller gets no refresh and no resend. request() checks again once the refresh
  // returns, for an abort that lands while it is pending (D-158).
  if (options.signal?.aborted) {
    throw abortError();
  }
  return checked(await request(path, options, await refreshedAccessToken(owner)));
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
  if (authServerFailed(error)) {
    checkService();
    throw new ApiError(AUTH_UNREACHABLE);
  }
  if (data.session === null) {
    if (isAuthRetryableFetchError(error)) {
      throw new ApiError(AUTH_UNREACHABLE);
    }
    return request(path, options);
  }
  const first = await request(path, options, data.session.access_token);
  if (first.status !== 401) {
    return checked(first);
  }
  return checked(await request(path, options, await refreshedAccessToken()));
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

async function readHealth(signal?: AbortSignal) {
  const response = await request('/health', { signal });
  // 503 is an answer, not a failure. The API is up and reporting that the database is not.
  if (response.status !== 200 && response.status !== 503) {
    throw await errorFrom('GET /health', response);
  }
  return {
    httpStatus: response.status,
    health: await parseBody('GET /health', response, HealthResponse),
  };
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return (await readHealth(signal)).health;
}

// The caller's own profile (D-109), with whether they still owe the consent screen (D-161).
export async function getMyProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  const response = await authenticatedRequest('/profiles/me', { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /profiles/me', response);
  }
  return parseBody('GET /profiles/me', response, ProfileResponse);
}

// A presigned PUT for a new profile photo. The API builds the key from the caller and the
// uploadId; the app never sees or sends one (root invariant 12). With an owner, only under that
// account's session, so a photo picked by one account never becomes another's avatar.
export async function createAvatarUpload(owner: string): Promise<CreateAvatarUploadResponse> {
  const response = await authenticatedRequest(
    '/profiles/me/avatar-upload',
    { method: 'POST' },
    owner,
  );
  if (response.status !== 200) {
    throw await errorFrom('POST /profiles/me/avatar-upload', response);
  }
  return parseBody('POST /profiles/me/avatar-upload', response, CreateAvatarUploadResponse);
}

// Sets the profile photo once its upload is in R2. It writes avatar_key and nothing else: no face
// check, no subject, no job (D-141). 409 upload_missing when the object is not there.
export async function setAvatar(owner: string, uploadId: string): Promise<SetAvatarResponse> {
  const response = await authenticatedRequest(
    '/profiles/me/avatar',
    { method: 'PUT', body: { uploadId } },
    owner,
  );
  if (response.status !== 200) {
    throw await errorFrom('PUT /profiles/me/avatar', response);
  }
  return parseBody('PUT /profiles/me/avatar', response, SetAvatarResponse);
}

// Records that `owner` accepted the consent text's current version (D-161). A 201 recorded it and a
// 200 found it already recorded, and the app treats both the same. It goes out only under the
// account the consent screen was showing, and needs a connection: it is never queued.
export async function acceptConsent(
  owner: string,
  body: AcceptConsentRequest,
): Promise<AcceptConsentResponse> {
  const response = await authenticatedRequest(
    '/profiles/me/consent',
    { method: 'POST', body },
    owner,
  );
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('POST /profiles/me/consent', response);
  }
  return parseBody('POST /profiles/me/consent', response, AcceptConsentResponse);
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

// The album state, the event's upload count and the Photographers who have uploaded nothing, for
// the event's Admin only (D-161). Manage's status card reads it, and the Close Album dialog asks
// again when it opens. Anyone else gets 403 not_member or wrong_role, and a deleted or unknown
// event 404 not_found.
export async function getAlbumStatus(
  eventId: string,
  signal?: AbortSignal,
): Promise<AlbumStatusResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/album`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}/album', response);
  }
  return parseBody('GET /events/{eventId}/album', response, AlbumStatusResponse);
}

// Opens or closes the album, for the event's Admin only, and answers the state it set (D-161). A
// repeat sets the same state, so a resend is safe, and two of the Admin's phones resolve as last
// write wins (D-142). No signal, for the reason createEvent has none: a PUT the screen stops
// waiting for may still land.
export async function setAlbum(
  eventId: string,
  body: SetAlbumRequest,
  owner?: string,
): Promise<SetAlbumResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/album`;
  const response = await authenticatedRequest(path, { method: 'PUT', body }, owner);
  if (response.status !== 200) {
    throw await errorFrom('PUT /events/{eventId}/album', response);
  }
  return parseBody('PUT /events/{eventId}/album', response, SetAlbumResponse);
}

// Managed credentials stay bound to the account that opened Invite (D-152).
export async function listInvites(
  owner: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ListInvitesResponse> {
  const response = await authenticatedRequest(
    `/events/${encodeURIComponent(eventId)}/invites`,
    { signal },
    owner,
  );
  if (response.status !== 200) throw await errorFrom('GET event invites', response);
  return parseBody('GET event invites', response, ListInvitesResponse);
}

export async function listVenueQrs(
  owner: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ListVenueQrsResponse> {
  const response = await authenticatedRequest(`/events/${eventId}/venue-qrs`, { signal }, owner);
  if (response.status !== 200) throw await errorFrom('GET venue QRs', response);
  return parseBody('GET venue QRs', response, ListVenueQrsResponse);
}

export async function regenerateVenueQr(
  owner: string,
  eventId: string,
  venueId: string,
  body: RegenerateVenueQrRequest,
): Promise<RegenerateVenueQrResponse> {
  const response = await authenticatedRequest(
    `/events/${eventId}/venue-qrs/${venueId}/regenerate`,
    { method: 'POST', body },
    owner,
  );
  if (response.status !== 200) throw await errorFrom('POST venue QR regeneration', response);
  const parsed = await parseBody('POST venue QR regeneration', response, RegenerateVenueQrResponse);
  if (parsed.venueQr.venueId.toLowerCase() !== venueId.toLowerCase())
    throw new ApiError('The response names another venue.', response.status);
  return parsed;
}

// The API replaces the displayed id atomically. Only a refused 401 permits a resend.
export async function regenerateInvite(
  owner: string,
  eventId: string,
  body: RegenerateInviteRequest,
): Promise<RegenerateInviteResponse> {
  const response = await authenticatedRequest(
    `/events/${encodeURIComponent(eventId)}/invites/regenerate`,
    { method: 'POST', body },
    owner,
  );
  if (response.status !== 200) throw await errorFrom('POST regenerate invite', response);
  const result = await parseBody('POST regenerate invite', response, RegenerateInviteResponse);
  if (result.invite.role !== body.role || result.invite.id === body.expectedInviteId) {
    throw new ApiError('The invite replacement does not match the requested role or id.', 200);
  }
  return result;
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

export async function forceVerifyAttendee(
  eventId: string,
  userId: string,
  body: ForceVerifyAttendeeRequest,
): Promise<ForceVerifyAttendeeResponse> {
  const path =
    '/events/' +
    encodeURIComponent(eventId) +
    '/attendees/' +
    encodeURIComponent(userId) +
    '/force-verify';
  const response = await authenticatedRequest(path, { method: 'POST', body });
  if (response.status !== 200) throw await errorFrom('POST attendee force-verify', response);
  return parseBody('POST attendee force-verify', response, ForceVerifyAttendeeResponse);
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
  const response = await authenticatedRequest(path, { method: 'POST', body, signal });
  if (response.status !== 200)
    throw await errorFrom('POST /events/{eventId}/media/status', response);
  return parseBody('POST /events/{eventId}/media/status', response, MediaStatusResponse);
}

// Pre-flight for one queued photo, as the account that queued it (D-146): JSON only, no image bytes
// (root invariant 5). A 201 made the media row and a 200 resumed the caller's own unfinished one,
// and both carry the two PUT URLs (D-122). The app never sees or builds an object key (root
// invariant 12). What each refusal does to the photo is features/upload-queue/transitions.ts.
export async function preflightUpload(
  owner: string,
  eventId: string,
  body: PreflightUploadRequest,
  signal?: AbortSignal,
): Promise<PreflightUploadResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/media/preflight`;
  const response = await authenticatedRequest(path, { method: 'POST', body, signal }, owner);
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('POST /events/{eventId}/media/preflight', response);
  }
  return parseBody('POST /events/{eventId}/media/preflight', response, PreflightUploadResponse);
}

// Completion after both PUTs, as the photo's uploader. Safe to repeat: a finished row answers 200
// again and enqueues nothing (D-95, D-122).
export async function completeUpload(
  owner: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<CompleteUploadResponse> {
  const path = `/media/${encodeURIComponent(mediaId)}/complete`;
  const response = await authenticatedRequest(path, { method: 'POST', signal }, owner);
  if (response.status !== 200) {
    throw await errorFrom('POST /media/{mediaId}/complete', response);
  }
  return parseBody('POST /media/{mediaId}/complete', response, CompleteUploadResponse);
}

// GET /events/{eventId}/media, for every active role except Photographer (D-148).
// Keyset cursor pagination over sub-events by start, then id, and captured_at desc, id desc.
export async function listAlbum(
  eventId: string,
  filters: ListAlbumRequest = {},
  signal?: AbortSignal,
): Promise<ListAlbumResponse> {
  const query = Object.entries(filters)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const path = `/events/${encodeURIComponent(eventId)}/media${query ? `?${query}` : ''}`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}/media', response);
  }
  return parseBody('GET /events/{eventId}/media', response, ListAlbumResponse);
}

// POST /events/{eventId}/media/images, for every active role (D-148).
// Signs 1 to 50 media ids. Omitted ids are absent from the map.
export async function getMediaImages(
  eventId: string,
  body: MediaImagesRequest,
  signal?: AbortSignal,
): Promise<MediaImagesResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/media/images`;
  const response = await authenticatedRequest(path, { method: 'POST', body, signal });
  if (response.status !== 200) {
    throw await errorFrom('POST /events/{eventId}/media/images', response);
  }
  return parseBody('POST /events/{eventId}/media/images', response, MediaImagesResponse);
}

// GET /events/{eventId}/media/uploaders, for every active role except Photographer (D-148).
// Lists active members with at least one published photo.
export async function listUploaders(
  eventId: string,
  signal?: AbortSignal,
): Promise<ListUploadersResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/media/uploaders`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}/media/uploaders', response);
  }
  return parseBody('GET /events/{eventId}/media/uploaders', response, ListUploadersResponse);
}

// GET /media/{mediaId}: whether the file this viewer gets has a Do Not Publish face or a blur
// region blurred in it, and whether they flagged the photo, for an active Guest or the Admin
// (D-179). It names no subject and no box.
export async function getMediaDetail(
  mediaId: string,
  signal?: AbortSignal,
): Promise<MediaDetailResponse> {
  const path = `/media/${encodeURIComponent(mediaId)}`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /media/{mediaId}', response);
  }
  return parseBody('GET /media/{mediaId}', response, MediaDetailResponse);
}

// POST /media/{mediaId}/flags, for an active Guest only. 201 stored the flag and 200 answered a
// repeat, which never reopens a kept flag, so a resend is safe (D-179).
export async function flagPhoto(mediaId: string): Promise<FlagPhotoResponse> {
  const path = `/media/${encodeURIComponent(mediaId)}/flags`;
  const response = await authenticatedRequest(path, { method: 'POST' });
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('POST /media/{mediaId}/flags', response);
  }
  return parseBody('POST /media/{mediaId}/flags', response, FlagPhotoResponse);
}

// DELETE /media/{mediaId}, for the photo's uploader or the event's Admin. Permanent (D-130). A
// repeat by either of them answers 200 with the first deletedAt and enqueues nothing, so a resend
// after a lost answer is safe (D-160, D-179).
export async function deleteMedia(mediaId: string): Promise<DeleteMediaResponse> {
  const path = `/media/${encodeURIComponent(mediaId)}`;
  const response = await authenticatedRequest(path, { method: 'DELETE' });
  if (response.status !== 200) {
    throw await errorFrom('DELETE /media/{mediaId}', response);
  }
  return parseBody('DELETE /media/{mediaId}', response, DeleteMediaResponse);
}

// POST /media/{mediaId}/blur-regions, for an active Guest or the Admin (spec §4.11.4.4). 201 stored
// a new region and 200 answered a resend of an id this caller already stored, so a retry with the
// same id is safe. Both carry the list after the write (D-170).
export async function addBlurRegion(
  mediaId: string,
  body: AddBlurRegionRequest,
): Promise<ListBlurRegionsResponse> {
  const path = `/media/${encodeURIComponent(mediaId)}/blur-regions`;
  const response = await authenticatedRequest(path, { method: 'POST', body });
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('POST /media/{mediaId}/blur-regions', response);
  }
  return parseBody('POST /media/{mediaId}/blur-regions', response, ListBlurRegionsResponse);
}

// GET /media/{mediaId}/blur-regions: a Guest's own regions on the photo, or every region for the
// Admin, each with who drew it (D-170).
export async function listBlurRegions(
  mediaId: string,
  signal?: AbortSignal,
): Promise<ListBlurRegionsResponse> {
  const path = `/media/${encodeURIComponent(mediaId)}/blur-regions`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /media/{mediaId}/blur-regions', response);
  }
  return parseBody('GET /media/{mediaId}/blur-regions', response, ListBlurRegionsResponse);
}

// DELETE /blur-regions/{regionId}. Answers the photo's list after the delete. A region already gone
// is 404 not_found, which a resend of a delete that landed also gets, so the caller treats that 404
// as done (shared-types blur-region.ts).
export async function removeBlurRegion(regionId: string): Promise<ListBlurRegionsResponse> {
  const path = `/blur-regions/${encodeURIComponent(regionId)}`;
  const response = await authenticatedRequest(path, { method: 'DELETE' });
  if (response.status !== 200) {
    throw await errorFrom('DELETE /blur-regions/{regionId}', response);
  }
  return parseBody('DELETE /blur-regions/{regionId}', response, ListBlurRegionsResponse);
}

// GET /events/{eventId}/review-queue/flags, for the event's Admin only (D-181). One page of
// photos with open flags, newest flag first, each collapsed into one entry that names no flagger.
export async function listFlaggedPhotos(
  eventId: string,
  query: ListFlaggedPhotosRequest = {},
  signal?: AbortSignal,
): Promise<ListFlaggedPhotosResponse> {
  const cursor = query.cursor ? `?cursor=${encodeURIComponent(query.cursor)}` : '';
  const path = `/events/${encodeURIComponent(eventId)}/review-queue/flags${cursor}`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}/review-queue/flags', response);
  }
  return parseBody('GET /events/{eventId}/review-queue/flags', response, ListFlaggedPhotosResponse);
}

// POST /media/{mediaId}/flags/keep, for the Admin only. Marks every open flag on the photo kept.
// A repeat answers 200 with keptCount 0, so a resend is safe (D-181).
export async function keepPhotoFlags(mediaId: string): Promise<KeepPhotoFlagsResponse> {
  const path = `/media/${encodeURIComponent(mediaId)}/flags/keep`;
  const response = await authenticatedRequest(path, { method: 'POST' });
  if (response.status !== 200) {
    throw await errorFrom('POST /media/{mediaId}/flags/keep', response);
  }
  return parseBody('POST /media/{mediaId}/flags/keep', response, KeepPhotoFlagsResponse);
}

// GET /events/{eventId}/review-queue/blur-regions, for the Admin only (D-181). One page of open
// Guest-drawn regions, newest first. The Admin's own regions start kept and never appear.
export async function listReviewBlurRegions(
  eventId: string,
  query: ListReviewBlurRegionsRequest = {},
  signal?: AbortSignal,
): Promise<ListReviewBlurRegionsResponse> {
  const cursor = query.cursor ? `?cursor=${encodeURIComponent(query.cursor)}` : '';
  const path = `/events/${encodeURIComponent(eventId)}/review-queue/blur-regions${cursor}`;
  const response = await authenticatedRequest(path, { signal });
  if (response.status !== 200) {
    throw await errorFrom('GET /events/{eventId}/review-queue/blur-regions', response);
  }
  return parseBody(
    'GET /events/{eventId}/review-queue/blur-regions',
    response,
    ListReviewBlurRegionsResponse,
  );
}

// POST /blur-regions/{regionId}/keep, for the Admin only. The region leaves the queue and stays on
// the photo (root invariant 6). A repeat answers 200, so a resend is safe (D-181).
export async function keepBlurRegion(regionId: string): Promise<KeepBlurRegionResponse> {
  const path = `/blur-regions/${encodeURIComponent(regionId)}/keep`;
  const response = await authenticatedRequest(path, { method: 'POST' });
  if (response.status !== 200) {
    throw await errorFrom('POST /blur-regions/{regionId}/keep', response);
  }
  return parseBody('POST /blur-regions/{regionId}/keep', response, KeepBlurRegionResponse);
}

// The caller's own reference photos in one event, any status (D-141). Nobody else's rows ever come
// back, the Admin's included. Owner-bound, because each one is presigned for its owner alone.
export async function listReferences(
  owner: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<ListReferencesResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/references`;
  const response = await authenticatedRequest(path, { signal }, owner);
  if (response.status !== 200) throw await errorFrom('GET /events/{eventId}/references', response);
  return parseBody('GET /events/{eventId}/references', response, ListReferencesResponse);
}

// A presigned PUT for a new reference. 422 too_many_references at five that are not rejected.
export async function createReferenceUpload(
  owner: string,
  eventId: string,
): Promise<CreateReferenceUploadResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/references/upload`;
  const response = await authenticatedRequest(path, { method: 'POST' }, owner);
  if (response.status !== 200) {
    throw await errorFrom('POST /events/{eventId}/references/upload', response);
  }
  return parseBody(
    'POST /events/{eventId}/references/upload',
    response,
    CreateReferenceUploadResponse,
  );
}

// Adds the uploaded reference as pending and queues the worker's one-face check. 201 for a new
// row, 200 for a resend of one already added, both with the list after the write.
export async function addReference(
  owner: string,
  eventId: string,
  uploadId: string,
): Promise<ListReferencesResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/references/${encodeURIComponent(uploadId)}`;
  const response = await authenticatedRequest(path, { method: 'PUT' }, owner);
  if (response.status !== 201 && response.status !== 200) {
    throw await errorFrom('PUT /events/{eventId}/references/{uploadId}', response);
  }
  return parseBody('PUT /events/{eventId}/references/{uploadId}', response, ListReferencesResponse);
}

// Deletes one reference, its embedding and its object. A 404 means it is already gone, which a
// resend of a delete that landed also gets, so the caller treats it as done.
export async function deleteReference(
  owner: string,
  eventId: string,
  referenceId: string,
): Promise<ListReferencesResponse> {
  const path = `/events/${encodeURIComponent(eventId)}/references/${encodeURIComponent(referenceId)}`;
  const response = await authenticatedRequest(path, { method: 'DELETE' }, owner);
  if (response.status !== 200) {
    throw await errorFrom('DELETE /events/{eventId}/references/{referenceId}', response);
  }
  return parseBody(
    'DELETE /events/{eventId}/references/{referenceId}',
    response,
    ListReferencesResponse,
  );
}
