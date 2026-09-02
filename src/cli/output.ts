import { CLI_ERROR_EXIT, SAFE_ERROR_MESSAGES, type CliErrorCode } from "./control_client.js";

export interface CliOutput {
  stdout: string;
  stderr: string;
}

export interface WritableCliStream {
  write(chunk: string): unknown;
}

export function writeSuccess(stream: WritableCliStream, json: boolean, data: unknown): void {
  if (json) {
    stream.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  stream.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function writeError(stream: WritableCliStream, json: boolean, code: CliErrorCode): void {
  const message = SAFE_ERROR_MESSAGES[code];
  if (json) {
    stream.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    return;
  }
  stream.write(`error: ${message}\n`);
}

export function exitCodeForError(code: CliErrorCode): number {
  return CLI_ERROR_EXIT[code];
}
