export const DEFAULT_WIRE_JSON_MAX_BYTES = 33_554_432;

export type WireJson =
  | null
  | boolean
  | string
  | WireJsonNumber
  | WireJsonArray
  | WireJsonObject;

export interface WireJsonNumber {
  readonly kind: "number";
  readonly lexeme: string;
}

export interface WireJsonArray {
  readonly kind: "array";
  readonly items: readonly WireJson[];
}

export interface WireJsonObject {
  readonly kind: "object";
  readonly members: readonly Readonly<{
    key: string;
    value: WireJson;
  }>[];
}

export interface WireJsonParseLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
}

export type WireJsonErrorCode =
  | "byte_limit"
  | "depth_limit"
  | "invalid_utf8"
  | "malformed_json"
  | "serialization_failure";

export class WireJsonError extends Error {
  readonly code: WireJsonErrorCode;
  override readonly cause?: unknown;

  constructor(code: WireJsonErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WireJsonError";
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const JSON_NUMBER_LEXEME = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

export function isWireJsonNumber(value: unknown): value is WireJsonNumber {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "number";
}

export function isWireJsonArray(value: unknown): value is WireJsonArray {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "array";
}

export function isWireJsonObject(value: unknown): value is WireJsonObject {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "object";
}

export function memberValues(object: WireJsonObject, key: string): readonly WireJson[] {
  return object.members.filter((member) => member.key === key).map((member) => member.value);
}

export function duplicateMemberNames(object: WireJsonObject): readonly string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const reported = new Set<string>();

  for (const member of object.members) {
    if (seen.has(member.key)) {
      if (!reported.has(member.key)) {
        duplicates.push(member.key);
        reported.add(member.key);
      }
    } else {
      seen.add(member.key);
    }
  }

  return duplicates;
}

export function parseWireJson(bytes: Uint8Array, limits: WireJsonParseLimits): WireJson {
  if (bytes.byteLength > limits.maxBytes) {
    throw new WireJsonError("byte_limit", `JSON input exceeds ${limits.maxBytes} bytes`);
  }

  return new Parser(bytes, limits.maxDepth).parseDocument();
}

export function serializeWireJson(value: WireJson): Uint8Array {
  const writer = new ByteWriter();
  writeValue(writer, value);
  return writer.finish();
}

class Parser {
  private pos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): WireJson {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.pos < this.bytes.byteLength) {
      this.unexpected("trailing JSON input");
    }
    return value;
  }

  private parseValue(depth: number): WireJson {
    this.skipWhitespace();
    const byte = this.peekByte();
    if (byte === undefined) {
      throw new WireJsonError("malformed_json", "unexpected end of JSON input");
    }

    if (byte === 0x7b || byte === 0x5b) {
      if (depth > this.maxDepth) {
        throw new WireJsonError("depth_limit", `JSON nesting exceeds ${this.maxDepth}`);
      }
      return byte === 0x7b ? this.parseObject(depth) : this.parseArray(depth);
    }

    if (byte === 0x22) {
      return this.parseString();
    }
    if (byte === 0x74) {
      this.expectAscii("true");
      return true;
    }
    if (byte === 0x66) {
      this.expectAscii("false");
      return false;
    }
    if (byte === 0x6e) {
      this.expectAscii("null");
      return null;
    }
    if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
      return this.parseNumber();
    }

    this.unexpected("unexpected JSON token");
  }

  private parseObject(depth: number): WireJsonObject {
    this.consumeByte();
    this.skipWhitespace();
    const members: Array<{ key: string; value: WireJson }> = [];

    if (this.peekByte() === 0x7d) {
      this.consumeByte();
      return { kind: "object", members };
    }

    for (;;) {
      this.skipWhitespace();
      if (this.peekByte() !== 0x22) {
        this.unexpected("expected object key");
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.peekByte() !== 0x3a) {
        this.unexpected("expected colon");
      }
      this.consumeByte();
      const value = this.parseValue(depth + 1);
      members.push({ key, value });
      this.skipWhitespace();
      const separator = this.peekByte();
      if (separator === 0x2c) {
        this.consumeByte();
        continue;
      }
      if (separator === 0x7d) {
        this.consumeByte();
        return { kind: "object", members };
      }
      this.unexpected("expected comma or end of object");
    }
  }

  private parseArray(depth: number): WireJsonArray {
    this.consumeByte();
    this.skipWhitespace();
    const items: WireJson[] = [];

    if (this.peekByte() === 0x5d) {
      this.consumeByte();
      return { kind: "array", items };
    }

    for (;;) {
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.peekByte();
      if (separator === 0x2c) {
        this.consumeByte();
        continue;
      }
      if (separator === 0x5d) {
        this.consumeByte();
        return { kind: "array", items };
      }
      this.unexpected("expected comma or end of array");
    }
  }

  private parseString(): string {
    this.consumeByte();
    let result = "";

    for (;;) {
      const byte = this.peekByte();
      if (byte === undefined) {
        throw new WireJsonError("malformed_json", "unterminated JSON string");
      }
      if (byte === 0x22) {
        this.consumeByte();
        return result;
      }
      if (byte === 0x5c) {
        result += this.parseEscape();
        continue;
      }
      if (byte < 0x20) {
        throw new WireJsonError("malformed_json", "unescaped control character in JSON string");
      }
      if (byte < 0x80) {
        this.consumeByte();
        result += String.fromCharCode(byte);
        continue;
      }
      result += String.fromCodePoint(this.consumeUtf8CodePoint());
    }
  }

  private parseEscape(): string {
    this.consumeByte();
    const marker = this.needByte("malformed_json");
    if (marker === 0x22) {
      return "\"";
    }
    if (marker === 0x5c) {
      return "\\";
    }
    if (marker === 0x2f) {
      return "/";
    }
    if (marker === 0x62) {
      return "\b";
    }
    if (marker === 0x66) {
      return "\f";
    }
    if (marker === 0x6e) {
      return "\n";
    }
    if (marker === 0x72) {
      return "\r";
    }
    if (marker === 0x74) {
      return "\t";
    }
    if (marker === 0x75) {
      return String.fromCharCode(this.parseHexCodeUnit());
    }
    throw new WireJsonError("malformed_json", "invalid JSON string escape");
  }

  private parseHexCodeUnit(): number {
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      const byte = this.needByte("malformed_json");
      const nibble = hexNibble(byte);
      if (nibble === undefined) {
        throw new WireJsonError("malformed_json", "invalid Unicode escape in JSON string");
      }
      value = (value << 4) | nibble;
    }
    return value;
  }

  private parseNumber(): WireJsonNumber {
    const start = this.pos;
    if (this.peekByte() === 0x2d) {
      this.consumeByte();
    }

    const first = this.peekByte();
    if (first === 0x30) {
      this.consumeByte();
    } else if (first !== undefined && first >= 0x31 && first <= 0x39) {
      this.consumeByte();
      this.consumeDigits();
    } else {
      throw new WireJsonError("malformed_json", "invalid JSON number");
    }

    if (this.peekByte() === 0x2e) {
      this.consumeByte();
      if (!this.consumeDigits()) {
        throw new WireJsonError("malformed_json", "invalid JSON number fraction");
      }
    }

    const exponent = this.peekByte();
    if (exponent === 0x65 || exponent === 0x45) {
      this.consumeByte();
      const sign = this.peekByte();
      if (sign === 0x2b || sign === 0x2d) {
        this.consumeByte();
      }
      if (!this.consumeDigits()) {
        throw new WireJsonError("malformed_json", "invalid JSON number exponent");
      }
    }

    return {
      kind: "number",
      lexeme: asciiSlice(this.bytes, start, this.pos),
    };
  }

  private consumeDigits(): boolean {
    let count = 0;
    while (isDigit(this.peekByte())) {
      this.consumeByte();
      count += 1;
    }
    return count > 0;
  }

  private expectAscii(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const expected = text.charCodeAt(index);
      const actual = this.peekByte();
      if (actual !== expected) {
        if (actual !== undefined && actual >= 0x80) {
          this.consumeUtf8CodePoint();
        }
        throw new WireJsonError("malformed_json", "invalid JSON literal");
      }
      this.consumeByte();
    }
  }

  private skipWhitespace(): void {
    for (;;) {
      const byte = this.peekByte();
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        return;
      }
      this.consumeByte();
    }
  }

  private peekByte(): number | undefined {
    return this.bytes[this.pos];
  }

  private consumeByte(): number {
    const byte = this.needByte("malformed_json");
    return byte;
  }

  private needByte(eofCode: WireJsonErrorCode): number {
    const byte = this.bytes[this.pos];
    if (byte === undefined) {
      throw new WireJsonError(eofCode, eofCode === "invalid_utf8"
        ? "truncated UTF-8 sequence"
        : "unexpected end of JSON input");
    }
    this.pos += 1;
    return byte;
  }

  private consumeUtf8CodePoint(): number {
    const b0 = this.needByte("invalid_utf8");
    if (b0 < 0x80) {
      return b0;
    }
    if (b0 < 0xc2 || b0 > 0xf4) {
      throw new WireJsonError("invalid_utf8", "invalid UTF-8 sequence");
    }

    if (b0 < 0xe0) {
      const b1 = this.needContinuation();
      const codePoint = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      if (codePoint < 0x80) {
        throw new WireJsonError("invalid_utf8", "overlong UTF-8 sequence");
      }
      return codePoint;
    }

    if (b0 < 0xf0) {
      const b1 = this.needContinuation();
      const b2 = this.needContinuation();
      const codePoint = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      if (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new WireJsonError("invalid_utf8", "invalid UTF-8 code point");
      }
      return codePoint;
    }

    const b1 = this.needContinuation();
    const b2 = this.needContinuation();
    const b3 = this.needContinuation();
    const codePoint = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
    if (codePoint < 0x10000 || codePoint > 0x10ffff) {
      throw new WireJsonError("invalid_utf8", "invalid UTF-8 code point");
    }
    return codePoint;
  }

  private needContinuation(): number {
    const byte = this.needByte("invalid_utf8");
    if ((byte & 0xc0) !== 0x80) {
      throw new WireJsonError("invalid_utf8", "invalid UTF-8 continuation");
    }
    return byte;
  }

  private unexpected(message: string): never {
    const byte = this.peekByte();
    if (byte !== undefined && byte >= 0x80) {
      this.consumeUtf8CodePoint();
    }
    throw new WireJsonError("malformed_json", message);
  }
}

class ByteWriter {
  private buffer = new Uint8Array(256);
  private length = 0;

  writeByte(byte: number): void {
    this.ensure(1);
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  writeAscii(text: string): void {
    this.ensure(text.length);
    for (let index = 0; index < text.length; index += 1) {
      this.buffer[this.length] = text.charCodeAt(index);
      this.length += 1;
    }
  }

  writeUtf8CodePoint(codePoint: number): void {
    if (codePoint < 0x80) {
      this.writeByte(codePoint);
      return;
    }
    if (codePoint < 0x800) {
      this.writeByte(0xc0 | (codePoint >> 6));
      this.writeByte(0x80 | (codePoint & 0x3f));
      return;
    }
    if (codePoint < 0x10000) {
      this.writeByte(0xe0 | (codePoint >> 12));
      this.writeByte(0x80 | ((codePoint >> 6) & 0x3f));
      this.writeByte(0x80 | (codePoint & 0x3f));
      return;
    }
    this.writeByte(0xf0 | (codePoint >> 18));
    this.writeByte(0x80 | ((codePoint >> 12) & 0x3f));
    this.writeByte(0x80 | ((codePoint >> 6) & 0x3f));
    this.writeByte(0x80 | (codePoint & 0x3f));
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private ensure(count: number): void {
    const needed = this.length + count;
    if (needed <= this.buffer.byteLength) {
      return;
    }
    let capacity = this.buffer.byteLength;
    while (capacity < needed) {
      capacity *= 2;
    }
    const next = new Uint8Array(capacity);
    next.set(this.buffer);
    this.buffer = next;
  }
}

function writeValue(writer: ByteWriter, value: WireJson): void {
  if (value === null) {
    writer.writeAscii("null");
    return;
  }
  if (value === true) {
    writer.writeAscii("true");
    return;
  }
  if (value === false) {
    writer.writeAscii("false");
    return;
  }
  if (typeof value === "string") {
    writeJsonString(writer, value);
    return;
  }
  if (value.kind === "number") {
    writeNumberLexeme(writer, value.lexeme);
    return;
  }
  if (value.kind === "array") {
    writer.writeByte(0x5b);
    for (const [index, item] of value.items.entries()) {
      if (index > 0) {
        writer.writeByte(0x2c);
      }
      writeValue(writer, item);
    }
    writer.writeByte(0x5d);
    return;
  }

  writer.writeByte(0x7b);
  for (const [index, member] of value.members.entries()) {
    if (index > 0) {
      writer.writeByte(0x2c);
    }
    writeJsonString(writer, member.key);
    writer.writeByte(0x3a);
    writeValue(writer, member.value);
  }
  writer.writeByte(0x7d);
}

function writeNumberLexeme(writer: ByteWriter, lexeme: string): void {
  if (!JSON_NUMBER_LEXEME.test(lexeme)) {
    throw new WireJsonError("serialization_failure", "invalid JSON number lexeme", {
      cause: new Error("number lexeme is not valid JSON"),
    });
  }
  writer.writeAscii(lexeme);
}

function writeJsonString(writer: ByteWriter, value: string): void {
  writer.writeByte(0x22);
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new WireJsonError("serialization_failure", "invalid string code point");
    }
    if (codePoint === 0x22) {
      writer.writeAscii("\\\"");
      continue;
    }
    if (codePoint === 0x5c) {
      writer.writeAscii("\\\\");
      continue;
    }
    if (codePoint === 0x08) {
      writer.writeAscii("\\b");
      continue;
    }
    if (codePoint === 0x09) {
      writer.writeAscii("\\t");
      continue;
    }
    if (codePoint === 0x0a) {
      writer.writeAscii("\\n");
      continue;
    }
    if (codePoint === 0x0c) {
      writer.writeAscii("\\f");
      continue;
    }
    if (codePoint === 0x0d) {
      writer.writeAscii("\\r");
      continue;
    }
    if (codePoint < 0x20 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      writer.writeAscii(`\\u${codePoint.toString(16).padStart(4, "0")}`);
      continue;
    }
    writer.writeUtf8CodePoint(codePoint);
  }
  writer.writeByte(0x22);
}

function hexNibble(byte: number): number | undefined {
  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30;
  }
  if (byte >= 0x41 && byte <= 0x46) {
    return byte - 0x41 + 10;
  }
  if (byte >= 0x61 && byte <= 0x66) {
    return byte - 0x61 + 10;
  }
  return undefined;
}

function isDigit(byte: number | undefined): byte is number {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function asciiSlice(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) {
      throw new WireJsonError("malformed_json", "invalid JSON number");
    }
    text += String.fromCharCode(byte);
  }
  return text;
}
