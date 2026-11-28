import { useEventId } from '@/features/event-shell/event-id';
import { ReviewQueueScreen } from '@/features/review-queue/review-queue-screen';

export default function ReviewQueueRoute() {
  return <ReviewQueueScreen eventId={useEventId()} />;
}
