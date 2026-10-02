import type { Ref } from 'react';
import type { TextInput, TextInputProps } from 'react-native';

export type TextFieldProps = Omit<
  TextInputProps,
  'className' | 'style' | 'placeholder' | 'placeholderTextColor' | 'secureTextEntry'
> & {
  // What the field is for. iOS shows it as the placeholder; Android as the floating label.
  label: string;
  // An example, shown on Android once the empty field has focus.
  placeholder?: string;
  // A password field: masked, with an eye button that shows what was typed.
  secure?: boolean;
  error?: string | null;
  // A line under the field that is not an error.
  helper?: string | null;
  // What the field sits on, so Android's floating label cuts the outline in the right color.
  on?: 'background' | 'surface';
  ref?: Ref<TextInput>;
};
