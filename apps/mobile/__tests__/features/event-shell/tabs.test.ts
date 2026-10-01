import { describe, expect, it } from '@jest/globals';
import { MembershipRole } from '@momentlens/shared-types';

import { eventHref, landingTab, redirectFor, tabHref, tabsFor } from '@/features/event-shell/tabs';

describe('tabsFor', () => {
  it('gives a Guest Home, My Media and Schedule, in that order', () => {
    expect(tabsFor('guest')).toEqual(['home', 'media', 'schedule']);
  });

  it('gives the Admin the Guest tabs and Manage', () => {
    expect(tabsFor('admin')).toEqual(['home', 'media', 'schedule', 'manage']);
  });

  it('never gives a Photographer Home or Manage (spec §4.10)', () => {
    expect(tabsFor('photographer')).toEqual(['media', 'schedule']);
    expect(tabsFor('photographer')).not.toContain('home');
    expect(tabsFor('photographer')).not.toContain('manage');
  });

  it('never gives a Guest Manage', () => {
    expect(tabsFor('guest')).not.toContain('manage');
  });

  it('gives every role Schedule, which a Photographer needs to upload (spec §4.10)', () => {
    for (const role of MembershipRole.options) {
      expect(tabsFor(role)).toContain('schedule');
    }
  });
});

describe('landingTab', () => {
  it('lands a Guest and the Admin on Home and a Photographer on My Media (D-118)', () => {
    expect(landingTab('guest')).toBe('home');
    expect(landingTab('admin')).toBe('home');
    expect(landingTab('photographer')).toBe('media');
  });

  it('is the first tab on the bar, so opening the event with no tab lands there', () => {
    for (const role of MembershipRole.options) {
      expect(tabsFor(role)[0]).toBe(landingTab(role));
    }
  });
});

describe('redirectFor', () => {
  it('sends a Photographer who opens Home or Manage to My Media', () => {
    expect(redirectFor('photographer', 'home')).toBe('media');
    expect(redirectFor('photographer', 'manage')).toBe('media');
  });

  it('sends a Guest who opens Manage to Home', () => {
    expect(redirectFor('guest', 'manage')).toBe('home');
  });

  it('sends someone who became a Photographer off the Home tab they had open', () => {
    expect(redirectFor('photographer', 'home')).toBe('media');
  });

  it('leaves every role on each tab it has', () => {
    for (const role of MembershipRole.options) {
      for (const tab of tabsFor(role)) {
        expect(redirectFor(role, tab)).toBeNull();
      }
    }
  });

  it('leaves the shell alone when no tab is open yet', () => {
    for (const role of MembershipRole.options) {
      expect(redirectFor(role, undefined)).toBeNull();
    }
  });

  it('sends a segment that is no tab at all to the landing tab', () => {
    expect(redirectFor('admin', 'settings')).toBe('home');
    expect(redirectFor('photographer', '')).toBe('media');
  });
});

describe('eventHref', () => {
  const id = '6f1c2a4e-8d3b-4c5a-9e7f-0a1b2c3d4e5f';

  it('opens a Guest and the Admin on Home', () => {
    expect(eventHref(id, 'guest')).toEqual({ pathname: '/event/[id]/home', params: { id } });
    expect(eventHref(id, 'admin')).toEqual({ pathname: '/event/[id]/home', params: { id } });
  });

  it('opens a Photographer on My Media, never Home', () => {
    expect(eventHref(id, 'photographer')).toEqual({
      pathname: '/event/[id]/media',
      params: { id },
    });
  });

  it('builds every tab route from its own file name', () => {
    expect(tabHref(id, 'schedule').pathname).toBe('/event/[id]/schedule');
    expect(tabHref(id, 'manage').pathname).toBe('/event/[id]/manage');
  });
});
