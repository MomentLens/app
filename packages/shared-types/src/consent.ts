import { z } from 'zod';

/**
 * The version of the consent text the app shows now. One version covers the Terms and the Privacy
 * Policy (spec §4.18, D-161). The app compares it with the account's last answer kept on the
 * phone, and `GET /profiles/me` answers `consentRequired` against it.
 *
 * Raise it only when the text changes materially. Every account then sees the consent screen at
 * its next launch, and POST /profiles/me/consent refuses the old version.
 */
export const PRIVACY_POLICY_VERSION = 1;

/**
 * POST /profiles/me/consent. Records that the caller accepted `policyVersion`. The user comes from
 * the token, never the body (D-161).
 *
 * - Any version but `PRIVACY_POLICY_VERSION` is a 400 `invalid_request`, and so is any other
 *   field. An app built for an older version cannot record it.
 * - No session, or an expired one, is a 401 `no_session`.
 * - Accepting needs a connection. The app never queues it (spec §4.18).
 */
export const AcceptConsentRequest = z.strictObject({
  policyVersion: z.literal(PRIVACY_POLICY_VERSION),
});
export type AcceptConsentRequest = z.infer<typeof AcceptConsentRequest>;

/**
 * POST /profiles/me/consent. A 201 when this call recorded the acceptance, a 200 when the caller
 * had already accepted this version, with the same body. The app keeps `policyVersion` as the
 * account's last answer, so an offline launch opens (spec §4.18).
 */
export const AcceptConsentResponse = z.object({
  policyVersion: z.literal(PRIVACY_POLICY_VERSION),
});
export type AcceptConsentResponse = z.infer<typeof AcceptConsentResponse>;
