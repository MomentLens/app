import * as Clipboard from 'expo-clipboard';
import { Platform, Pressable, Text } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { useTokenColor } from '@/hooks/use-token-color';

interface PasteButtonProps {
  onPaste: (text: string) => void;
  // Called when the clipboard held no text, so the screen can say so.
  onEmpty: () => void;
  disabled?: boolean;
}

// iOS 16 and later have UIPasteControl, the system's own Paste button, which reads the clipboard
// without the "Allow Paste" alert a read from code brings up. Its label and icon are the system's.
const NATIVE_PASTE = Platform.OS === 'ios' && Clipboard.isPasteButtonAvailable;

// Paste, sized for each platform's touch target: 44 points on iOS, and on Android a Material 3
// tonal button, 40dp tall inside a 48dp target.
export function PasteButton({ onPaste, onEmpty, disabled = false }: PasteButtonProps) {
  const background = useTokenColor('accentTint');
  const foreground = useTokenColor('accentText');

  if (NATIVE_PASTE) {
    return (
      <Clipboard.ClipboardPasteButton
        acceptedContentTypes={['plain-text', 'url']}
        displayMode="iconAndLabel"
        cornerStyle="capsule"
        backgroundColor={background}
        foregroundColor={foreground}
        pointerEvents={disabled ? 'none' : 'auto'}
        style={{ height: 44, width: 112, opacity: disabled ? 0.6 : 1 }}
        onPress={(data) => {
          if (data.type === 'text' && data.text.trim() !== '') {
            onPaste(data.text);
          } else {
            onEmpty();
          }
        }}
      />
    );
  }

  async function paste() {
    const text = await Clipboard.getStringAsync();
    if (text.trim() === '') {
      onEmpty();
    } else {
      onPaste(text);
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Paste"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => void paste()}
      className={`h-10 flex-row items-center gap-2 rounded-full bg-accentTint px-5 active:opacity-80 ios:h-11 ${disabled ? 'opacity-60' : ''}`}>
      <Icon name="clipboard-paste" size={18} className="text-accentText" />
      <Text className="font-fieldLabel text-fieldLabel text-accentText">Paste</Text>
    </Pressable>
  );
}
