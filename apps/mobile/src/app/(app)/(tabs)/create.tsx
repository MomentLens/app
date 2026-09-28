// The route behind iOS 26's Create Event button in the tab bar (components/app-tabs.tsx). That tab
// is disabled, so this screen is never shown; its press opens the wizard. Other platforms name no
// trigger for it, and native tabs cannot reach a route without one.
export default function CreateTab() {
  return null;
}
