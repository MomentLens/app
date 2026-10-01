import type { MembershipRole } from '@momentlens/shared-types';

// The Event shell's tabs, each the name of its route file in app/(app)/event/[id]/.
export type EventTab = 'home' | 'media' | 'schedule' | 'manage';

// Spec §2.5.1's table, in tab bar order. The first tab is the role's landing tab: Home for a Guest
// and the Admin, My Media for a Photographer, who never sees Home or Manage (spec §4.10, D-118).
// The only place in the app that knows which role gets which tab.
const TABS_BY_ROLE: Record<MembershipRole, readonly EventTab[]> = {
  guest: ['home', 'media', 'schedule'],
  admin: ['home', 'media', 'schedule', 'manage'],
  photographer: ['media', 'schedule'],
};

// Each tab's route, with the event's id as its one param.
const TAB_PATHNAME = {
  home: '/event/[id]/home',
  media: '/event/[id]/media',
  schedule: '/event/[id]/schedule',
  manage: '/event/[id]/manage',
} as const satisfies Record<EventTab, string>;

export function tabHref(eventId: string, tab: EventTab) {
  return { pathname: TAB_PATHNAME[tab], params: { id: eventId } };
}

// Where opening an event goes: the role's landing tab (D-118). A role that changed since the caller
// learned it still lands right, because the shell redirects a tab the new role lacks.
export function eventHref(eventId: string, role: MembershipRole) {
  return tabHref(eventId, landingTab(role));
}

export function tabsFor(role: MembershipRole): readonly EventTab[] {
  return TABS_BY_ROLE[role];
}

export function landingTab(role: MembershipRole): EventTab {
  return TABS_BY_ROLE[role][0];
}

// Where the shell sends a role that opened `requested`, the route segment after the event's id: its
// landing tab when the role lacks that tab, and null when it may stay. A link to `home` or `manage`
// reaches a Photographer this way, and so does a role change while the old role's tab is open
// (D-118). No segment means the shell opens on its first tab, which is already the landing one.
export function redirectFor(role: MembershipRole, requested: string | undefined): EventTab | null {
  if (requested === undefined) {
    return null;
  }
  return (TABS_BY_ROLE[role] as readonly string[]).includes(requested) ? null : landingTab(role);
}
