import { SHORTCODE_LENGTH } from '@momentlens/shared-types';
import { useRef, useState } from 'react';
import {
  Platform,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import Animated, { useReducedMotion, type CSSAnimationKeyframes } from 'react-native-reanimated';

interface CodeBoxesProps {
  code: string;
  // The field's whole text after a change, or only the pasted part when a paste landed on a code
  // already started. Manual Join Entry reads it with readInviteInput.
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  invalid: boolean;
}

// The code splits 3 + 3 with a wider gap, the way a six-character code is easiest to read back.
const GROUP = SHORTCODE_LENGTH / 2;

// On for half a second, off for half, like the system caret.
const BLINK: CSSAnimationKeyframes = {
  '0%': { opacity: 1 },
  '50%': { opacity: 1 },
  '51%': { opacity: 0 },
  '100%': { opacity: 0 },
};

function Caret() {
  const reduceMotion = useReducedMotion();
  return (
    <Animated.View
      style={
        reduceMotion
          ? undefined
          : {
              animationName: BLINK,
              animationDuration: '1s',
              animationIterationCount: 'infinite',
            }
      }>
      <View className="h-7 w-0.5 rounded-full bg-accent" />
    </Animated.View>
  );
}

// Six boxes, one per character, over one text input the size of the row (spec §2.4).
//
// One input rather than six is what makes a paste fill every box and backspace walk back across
// them, with the keyboard never closing between boxes as it can on Android when focus hops. The
// input draws nothing: its text, caret and selection are transparent, and the boxes show the
// code. It still takes every tap, so a long press brings up the system Paste.
//
// The caret belongs at the end, where the boxes show it. A tap that puts it anywhere else is
// moved back, so a key press never lands in the middle of the code. It is corrected rather than
// held with the selection prop, which fast typing can outrun: a stale selection from JavaScript
// moves the native caret back mid-burst and scrambles the order of what was typed.
export function CodeBoxes({ code, onChangeText, onSubmit, invalid }: CodeBoxesProps) {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const active = focused ? Math.min(code.length, SHORTCODE_LENGTH - 1) : -1;

  // With the caret at the end, a paste lands after the code already there. Six or more characters
  // arriving at once are a paste, never typing, so they replace the code instead of running on.
  // Anything shorter is typing, which a slow phone can deliver a few characters at a time.
  function change(text: string) {
    const added = text.startsWith(code) ? text.slice(code.length) : null;
    onChangeText(added !== null && added.length >= SHORTCODE_LENGTH ? added : text);
  }

  function keepCaretAtEnd(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) {
    const { start, end } = event.nativeEvent.selection;
    if (start < code.length || end < code.length) {
      inputRef.current?.setSelection(code.length, code.length);
    }
  }

  return (
    <View className="flex-row">
      {Array.from({ length: SHORTCODE_LENGTH }, (_, index) => {
        const character = code[index];
        const border =
          index === active
            ? `border-2 ${invalid ? 'border-danger' : 'border-accent'}`
            : `border ${invalid ? 'border-danger' : character ? 'border-borderStrong' : 'border-border'}`;
        return (
          <View
            key={index}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className={`h-14 flex-1 items-center justify-center rounded-xl bg-surface ${border} ${index === GROUP ? 'ml-4' : index > 0 ? 'ml-2' : ''}`}>
            {character ? (
              <Text className="font-h2 text-h2 text-textPrimary">{character}</Text>
            ) : index === active ? (
              <Caret />
            ) : null}
          </View>
        );
      })}
      <TextInput
        ref={inputRef}
        value={code}
        onChangeText={change}
        onSelectionChange={keepCaretAtEnd}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel="Invite code"
        accessibilityHint="Six letters and numbers. You can also paste the invite link."
        autoFocus
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        // Android's password keyboard has a number row and no suggestion strip, which suits a
        // code of letters and digits. Its text is not masked; secureTextEntry does that.
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        returnKeyType="go"
        // The keyboard stays up after Go, so a code that failed can be corrected straight away.
        submitBehavior="submit"
        caretHidden
        selectionColor="transparent"
        // Android draws a transparent text color in the default color instead, so there the
        // field hides by opacity. It still takes focus, typing and a paste.
        className="absolute inset-0 text-transparent android:opacity-0"
      />
    </View>
  );
}
