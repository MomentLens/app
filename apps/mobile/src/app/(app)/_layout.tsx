import AppTabs from '@/components/app-tabs';

// The signed-in app. The root layout mounts this group only while someone is signed in.
export default function AppLayout() {
  return <AppTabs />;
}
