import { describe, expect, it } from '@jest/globals';
import { UpdateEventSettingsRequest, type EventSettings } from '@momentlens/shared-types';

import {
  approvalNote,
  listNames,
  saveProblem,
  settingsPatch,
  settingsProblems,
  shownSettings,
  stillWaitingMessage,
  switchMessage,
} from '@/features/manage/settings';

const SETTINGS: EventSettings = {
  name: 'Him & Her',
  description: 'Three days in Lahore.',
  approvalMode: 'manual',
  cover: null,
  pendingCount: 0,
  pendingPhotographers: [],
};

describe('shownSettings', () => {
  it('shows the saved settings when nothing is edited', () => {
    expect(shownSettings(SETTINGS, {})).toEqual({
      name: 'Him & Her',
      description: 'Three days in Lahore.',
      approvalMode: 'manual',
    });
  });

  it('shows an empty description for none', () => {
    expect(shownSettings({ ...SETTINGS, description: null }, {}).description).toBe('');
  });

  it('shows each edit over the saved value', () => {
    expect(
      shownSettings(SETTINGS, { name: 'Ayesha', description: '', approvalMode: 'auto' }),
    ).toEqual({ name: 'Ayesha', description: '', approvalMode: 'auto' });
  });
});

describe('settingsPatch', () => {
  it('is null when nothing is edited', () => {
    expect(settingsPatch(SETTINGS, {})).toBeNull();
  });

  it('is null when every edit matches what is saved', () => {
    expect(
      settingsPatch(SETTINGS, {
        name: 'Him & Her',
        description: 'Three days in Lahore.',
        approvalMode: 'manual',
      }),
    ).toBeNull();
  });

  it('compares the name and description trimmed, as the schema stores them', () => {
    expect(
      settingsPatch(SETTINGS, { name: '  Him & Her ', description: 'Three days in Lahore.\n' }),
    ).toBeNull();
  });

  it('sends only the name when only the name changed, trimmed', () => {
    expect(settingsPatch(SETTINGS, { name: ' Ayesha & Bilal ' })).toEqual({
      name: 'Ayesha & Bilal',
    });
  });

  it('sends an empty description to clear it', () => {
    expect(settingsPatch(SETTINGS, { description: '   ' })).toEqual({ description: '' });
  });

  it('sends nothing for an empty description when there is none', () => {
    expect(settingsPatch({ ...SETTINGS, description: null }, { description: '' })).toBeNull();
  });

  it('sends a new description when there was none', () => {
    expect(
      settingsPatch({ ...SETTINGS, description: null }, { description: 'Dress code is formal.' }),
    ).toEqual({ description: 'Dress code is formal.' });
  });

  it('sends Approval Mode when it changed', () => {
    expect(settingsPatch(SETTINGS, { approvalMode: 'auto' })).toEqual({ approvalMode: 'auto' });
  });

  // Another phone saved the same change since this form opened, and the settings refetched.
  it('drops an edit the saved settings have caught up with', () => {
    const edits = { name: 'Ayesha', approvalMode: 'auto' as const };
    expect(settingsPatch({ ...SETTINGS, name: 'Ayesha' }, edits)).toEqual({
      approvalMode: 'auto',
    });
  });

  it('sends every changed field together', () => {
    expect(
      settingsPatch(SETTINGS, { name: 'Ayesha', description: '', approvalMode: 'auto' }),
    ).toEqual({ name: 'Ayesha', description: '', approvalMode: 'auto' });
  });

  it('builds a body the shared schema accepts', () => {
    const patch = settingsPatch(SETTINGS, { name: 'Ayesha', description: '' });
    expect(UpdateEventSettingsRequest.safeParse(patch).success).toBe(true);
  });

  // The strict schema refuses anything else, and S-31 opens the album (D-142).
  it('never carries a field the form does not edit', () => {
    const patch = settingsPatch(SETTINGS, {
      name: 'Ayesha',
      description: 'x',
      approvalMode: 'auto',
    });
    expect(Object.keys(patch ?? {}).sort()).toEqual(['approvalMode', 'description', 'name']);
  });
});

describe('settingsProblems', () => {
  it('has none for a valid form', () => {
    expect(settingsProblems({ name: 'Him & Her', description: '' })).toEqual({});
  });

  it('asks for a name when it is empty or only spaces', () => {
    expect(settingsProblems({ name: '   ', description: '' }).name).toBe(
      'Enter a name for the event.',
    );
  });

  it('counts the name in characters, so 80 emoji fit and 81 do not', () => {
    expect(settingsProblems({ name: '🎉'.repeat(80), description: '' }).name).toBeUndefined();
    expect(settingsProblems({ name: '🎉'.repeat(81), description: '' }).name).toBe(
      'Keep the name to 80 characters.',
    );
  });

  it('allows a description of 500 characters and refuses 501', () => {
    expect(
      settingsProblems({ name: 'A', description: 'a'.repeat(500) }).description,
    ).toBeUndefined();
    expect(settingsProblems({ name: 'A', description: 'a'.repeat(501) }).description).toBe(
      'Keep the description to 500 characters.',
    );
  });
});

describe('listNames', () => {
  it('joins names as a sentence does', () => {
    expect(listNames(['Ali'])).toBe('Ali');
    expect(listNames(['Ali', 'Sara'])).toBe('Ali and Sara');
    expect(listNames(['Ali', 'Sara', 'Bilal'])).toBe('Ali, Sara and Bilal');
  });
});

describe('approvalNote', () => {
  it('describes manual with nobody waiting', () => {
    expect(approvalNote('manual', 'manual', 0, 0)).toBe(
      'You approve each person before they join.',
    );
  });

  it('counts the requests waiting on a manual event', () => {
    expect(approvalNote('manual', 'manual', 1, 0)).toBe(
      'You approve each person before they join. 1 request is waiting.',
    );
    expect(approvalNote('manual', 'manual', 4, 1)).toBe(
      'You approve each person before they join. 4 requests are waiting.',
    );
  });

  it('describes auto with nobody waiting', () => {
    expect(approvalNote('auto', 'auto', 0, 0)).toBe(
      'Anyone with an invite joins straight away. Turn it on to approve each person first.',
    );
  });

  // Guests the cap left pending at an earlier switch (D-142).
  it('counts the requests still waiting on an auto event', () => {
    expect(approvalNote('auto', 'auto', 3, 0)).toBe(
      'Anyone with an invite joins straight away. 3 requests are still waiting for you to approve them.',
    );
    expect(approvalNote('auto', 'auto', 1, 0)).toBe(
      'Anyone with an invite joins straight away. 1 request is still waiting for you to approve it.',
    );
  });

  it('says what saving a switch to auto will do for Guests, whom the cap can hold back', () => {
    expect(approvalNote('manual', 'auto', 0, 0)).toBe('Anyone with an invite joins straight away.');
    expect(approvalNote('manual', 'auto', 5, 0)).toBe(
      'Anyone with an invite joins straight away. Saving lets in the 5 Guests waiting now, until the event is full.',
    );
    expect(approvalNote('manual', 'auto', 1, 0)).toBe(
      'Anyone with an invite joins straight away. Saving lets in the Guest waiting now, unless the event is full.',
    );
  });

  // spec §4.17: the cap counts Guests only, so a full event still lets a Photographer in.
  it('never says a full event holds back a Photographer', () => {
    expect(approvalNote('manual', 'auto', 1, 1)).toBe(
      'Anyone with an invite joins straight away. Saving lets in the Photographer waiting now.',
    );
    expect(approvalNote('manual', 'auto', 2, 2)).toBe(
      'Anyone with an invite joins straight away. Saving lets in the 2 Photographers waiting now.',
    );
    expect(approvalNote('manual', 'auto', 2, 1)).toBe(
      'Anyone with an invite joins straight away. Saving lets in the Photographer, and the Guest waiting now, unless the event is full.',
    );
    expect(approvalNote('manual', 'auto', 6, 2)).toBe(
      'Anyone with an invite joins straight away. Saving lets in the 2 Photographers, and the 4 Guests waiting now, until the event is full.',
    );
  });

  // Switching back changes no membership (D-142).
  it('counts the requests still waiting when switching an auto event back to manual', () => {
    expect(approvalNote('auto', 'manual', 2, 0)).toBe(
      'You approve each person before they join. 2 requests are waiting.',
    );
  });
});

describe('switchMessage', () => {
  it('is null when nobody is waiting, so the switch saves without asking', () => {
    expect(switchMessage(0, [])).toBeNull();
  });

  it('counts the Guests when no Photographer is waiting', () => {
    expect(switchMessage(4, [])).toBe(
      '4 people are waiting to join. The 4 Guests join oldest first, until the event is full. Any left over keep waiting.',
    );
    expect(switchMessage(1, [])).toBe(
      '1 person is waiting to join. The Guest joins too, unless the event is already full.',
    );
  });

  // D-139: a Photographer uploads from anywhere with no check-in, so each is named.
  it('names each Photographer', () => {
    expect(switchMessage(1, ['Sara Ahmed'])).toBe(
      '1 person is waiting to join. Sara Ahmed joins as a Photographer, who can upload from anywhere without checking in.',
    );
    expect(switchMessage(5, ['Sara Ahmed', 'Ali Khan'])).toBe(
      '5 people are waiting to join. Sara Ahmed and Ali Khan join as Photographers, who can upload from anywhere without checking in. The 3 Guests join oldest first, until the event is full. Any left over keep waiting.',
    );
  });
});

describe('stillWaitingMessage', () => {
  it('is null when the switch let everyone in', () => {
    expect(stillWaitingMessage(6, 0)).toBeNull();
  });

  it('says how many were let in and how many the cap left waiting', () => {
    expect(stillWaitingMessage(2, 3)).toBe(
      '2 requests were let in. The event is full, so 3 are still waiting for you to approve them.',
    );
    expect(stillWaitingMessage(1, 1)).toBe(
      '1 request was let in. The event is full, so 1 is still waiting for you to approve it.',
    );
    expect(stillWaitingMessage(0, 2)).toBe(
      'The event is full, so 2 are still waiting for you to approve them.',
    );
  });
});

describe('saveProblem', () => {
  it('says nothing was saved when MomentLens could not be reached', () => {
    expect(saveProblem({}, 'details')).toBe(
      'MomentLens could not be reached, so nothing was saved. Check the connection and try again.',
    );
    expect(saveProblem({}, 'check')).toBe(
      'MomentLens could not be reached, so nothing was saved. Check the connection and try again.',
    );
    expect(saveProblem({}, 'cover')).toBe(
      'The cover did not upload. Check the connection and try again.',
    );
  });

  // A switch to auto that times out may still have let people in, so it must not read as nothing.
  it('never says nothing was saved when a write timed out', () => {
    expect(saveProblem({ timedOut: true }, 'details')).toBe(
      'MomentLens did not answer in time, so the changes may or may not have saved. If Save is still on once the form refreshes, try again.',
    );
    expect(saveProblem({ timedOut: true }, 'cover', true)).toBe(
      'Your other changes are saved. MomentLens did not answer in time, so the cover may or may not have saved. Try again.',
    );
  });

  // The read before a switch writes nothing, so its timeout saved nothing either.
  it('says nothing was saved when the read before a switch timed out', () => {
    expect(saveProblem({ timedOut: true }, 'check')).toBe(
      'MomentLens could not be reached, so nothing was saved. Check the connection and try again.',
    );
  });

  it('says what will help for each way the PUT to R2 can fail', () => {
    expect(saveProblem({ cover: 'file_missing' }, 'cover')).toBe(
      'The photo you picked is no longer on this phone. Pick it again.',
    );
    expect(saveProblem({ cover: 'unreachable' }, 'cover')).toBe(
      'The cover did not upload. Check the connection and try again.',
    );
    expect(saveProblem({ cover: 'refused' }, 'cover')).toBe('The cover did not upload. Try again.');
  });

  it('says a cover the API cannot find did not finish uploading', () => {
    expect(saveProblem({ status: 409, code: 'upload_missing' }, 'cover')).toBe(
      'The cover did not finish uploading. Try again.',
    );
  });

  // Save sends the details first, so a cover that fails after them leaves them saved.
  it('says the other changes are saved when only the cover failed after them', () => {
    expect(saveProblem({ cover: 'unreachable' }, 'cover', true)).toBe(
      'Your other changes are saved. The cover did not upload. Check the connection and try again.',
    );
  });

  it('explains a lost place in the event, which the Event shell then shows', () => {
    expect(saveProblem({ status: 403, code: 'not_member' }, 'details')).toBe(
      'You can no longer change this event.',
    );
    expect(saveProblem({ status: 403, code: 'wrong_role' }, 'cover')).toBe(
      'You can no longer change this event.',
    );
    expect(saveProblem({ status: 404, code: 'not_found' }, 'check')).toBe(
      'This event is no longer available.',
    );
  });

  it('covers a refused body, an expired sign-in and anything else', () => {
    expect(saveProblem({ status: 400, code: 'invalid_request' }, 'details')).toBe(
      'MomentLens refused these details. Check each field and try again.',
    );
    expect(saveProblem({ status: 401, code: 'no_session' }, 'details')).toBe(
      'Your sign-in could not be confirmed. Try again.',
    );
    expect(saveProblem({ status: 500, code: 'internal_error' }, 'details')).toBe(
      'Something went wrong on our side. Try again in a moment.',
    );
  });
});
