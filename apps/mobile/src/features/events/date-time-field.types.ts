export interface DateTimeFieldProps {
  // The row's title on iOS, "Starts" or "Ends".
  label: string;
  // The two outlined fields' labels on Android, "Start date" and "Start time".
  dateLabel: string;
  timeLabel: string;
  value: Date;
  onChange: (value: Date) => void;
  error?: string;
}
