export interface DurationPickerProps {
  // Minutes, a multiple of MINUTE_STEP below a day.
  minutes: number;
  onChange: (minutes: number) => void;
}
