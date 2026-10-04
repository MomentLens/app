import { useLocalSearchParams } from 'expo-router';

import { AttendeeSheet } from '@/features/manage/attendee-sheet';

export default function AttendeeRoute() {
  const { eventId, userId, search, role } = useLocalSearchParams<{
    eventId: string;
    userId: string;
    search?: string;
    role?: string;
  }>();
  const selectedRole =
    role === 'admin' || role === 'guest' || role === 'photographer' ? role : undefined;
  return (
    <AttendeeSheet
      eventId={eventId}
      userId={userId}
      filters={{ search: search ?? '', role: selectedRole }}
    />
  );
}
