import { Redirect } from 'expo-router';

// The route behind iOS 26's Create Event button in the tab bar (components/app-tabs.tsx). That tab
// is disabled, so a press never selects it; the press opens the wizard instead.
//
// Only a link to /create could still focus it. On iOS 26 that lands here and goes on to Events.
// Elsewhere no trigger names the route, so native tabs cannot show it. A development build stops
// with their "focused tab cannot be displayed" error, and a release build shows Events. Nothing
// in the app links here.
export default function CreateTab() {
  return <Redirect href="/" />;
}
