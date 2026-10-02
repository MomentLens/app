import type { EventType } from '@momentlens/shared-types';

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  wedding: 'Wedding',
  engagement: 'Engagement',
  other: 'Other',
};

export const EVENT_TYPES: readonly EventType[] = ['wedding', 'engagement', 'other'];

export interface TypeSelectProps {
  value: EventType | null;
  onChange: (value: EventType) => void;
  error?: string;
}
