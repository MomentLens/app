import { PRIVACY_POLICY_VERSION } from '@momentlens/shared-types';

import type { GlyphName } from '@/components/ui/glyph';

// The consent text: the Terms and the Privacy Policy under one version number (spec §4.18, D-161).
// A draft from spec §4.18 for Ukasha to review on S-31's mobile PR. S-29's About & Legal shows the
// same text, so it lives here rather than in the screen.
//
// A material change to any of it raises PRIVACY_POLICY_VERSION in packages/shared-types, which
// pauses every account at its next launch until it accepts the new version.

export const CONSENT_TITLE = 'Before you start';

export const CONSENT_INTRO =
  'MomentLens collects and shares photos from the events you join. Here is what it does with your account, the faces in photos and your location.';

export interface ConsentSection {
  key: string;
  glyph: GlyphName;
  title: string;
  body: string;
}

export const CONSENT_SECTIONS: readonly ConsentSection[] = [
  {
    key: 'account',
    glyph: { ios: 'person.crop.circle', android: 'account_circle' },
    title: 'Your account',
    body: 'Your account keeps your name, your email address and a profile photo if you add one, for as long as the account exists. Members of an event you join can see your name.',
  },
  {
    key: 'faces',
    glyph: { ios: 'face.smiling', android: 'face' },
    title: 'Faces in photos',
    body: 'MomentLens detects every face in every photo uploaded to an event and turns each one into a face embedding, a set of numbers that describes it. This includes the faces of people who do not use the app. The embeddings are how Find My Photos finds you and how Do Not Publish blurs you.',
  },
  {
    key: 'dnp',
    glyph: { ios: 'eye.slash', android: 'visibility_off' },
    title: 'Do Not Publish is permanent',
    body: "You can turn on Do Not Publish in each event separately, and MomentLens then blurs your face in that event's photos for everyone but you. Once it is on for an event, you cannot turn it off.",
  },
  {
    key: 'metadata',
    glyph: { ios: 'photo', android: 'image' },
    title: 'What a photo carries',
    body: 'Before a photo leaves your phone, MomentLens removes everything stored inside the file, including its location, the camera model and the device serial number. The time the photo was taken is sent beside it, so the album can sort it.',
  },
  {
    key: 'location',
    glyph: { ios: 'location', android: 'my_location' },
    title: 'Your location',
    body: 'To check you in at a venue, your phone keeps one location reading for each sub-event when its check passes. The reading stays on your phone until your next upload sends it to MomentLens, which checks it against the venue and stores no coordinates.',
  },
];

export const CONSENT_FOOTNOTE = `By agreeing you accept the MomentLens Terms and Privacy Policy, version ${PRIVACY_POLICY_VERSION}, which this page sets out.`;
