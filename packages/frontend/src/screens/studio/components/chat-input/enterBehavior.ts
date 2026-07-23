export function shouldSendMessageOnEnter(inputValue: string): boolean {
  const normalizedInputValue = inputValue.replace(/\r/g, "");
  const nonEmptyLineCount = normalizedInputValue
    .split("\n")
    .reduce((count, line) => (line.trim().length > 0 ? count + 1 : count), 0);
  return nonEmptyLineCount <= 1;
}
