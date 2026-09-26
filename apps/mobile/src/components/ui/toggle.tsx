import { cssInterop } from 'nativewind';
import { Switch, type SwitchProps } from 'react-native';

type SwitchWithColorProps = SwitchProps & { onColor?: string };

function SwitchWithColor({ onColor, ...props }: SwitchWithColorProps) {
  return <Switch trackColor={{ false: undefined, true: onColor }} {...props} />;
}

// React Native's Switch takes its colors as props, which a class cannot reach. This moves the
// color of a text-* token class onto the "on" track, as icon.tsx does for an Svg, so the switch
// follows the tokens in dark mode with no hex. The "off" track keeps the platform's own.
export const Toggle = cssInterop(SwitchWithColor, {
  className: { target: 'style', nativeStyleToProp: { color: 'onColor' } },
});
