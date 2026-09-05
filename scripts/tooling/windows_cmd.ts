export function windowsCmdCommandLine(command: string, args: readonly string[]): string {
  return `"${[quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ")}"`;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
