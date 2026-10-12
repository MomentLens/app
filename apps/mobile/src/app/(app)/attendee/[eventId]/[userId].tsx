import { useLocalSearchParams } from 'expo-router';

import { AttendeeSheet } from '@/features/manage/attendee-sheet';

export default function AttendeeRoute() {
  const { eventId, userId, search, role, subEventId, checkIn } = useLocalSearchParams<{
    eventId: string;
    userId: string;
    search?: string;
    role?: string;
    subEventId?: string;
    checkIn?: string;
  }>();
  const selectedRole =
    role === 'admin' || role === 'guest' || role === 'photographer' ? role : undefined;
  const selectedSubEventId = subEventId || undefined;
  const selectedCheckIn =
    checkIn === 'checked_in' || checkIn === 'not_checked_in' ? checkIn : undefined;
  return (
    <AttendeeSheet
      eventId={eventId}
      userId={userId}
      filters={{
        search: search ?? '',
        role: selectedRole,
        subEventId: selectedSubEventId,
        checkIn: selectedSubEventId ? selectedCheckIn : undefined,
      }}
    />
  );
}
