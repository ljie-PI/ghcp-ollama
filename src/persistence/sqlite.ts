import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { types } from "node:util";

type SqliteValue = Exclude<SQLOutputValue, Uint8Array | bigint> | Buffer;
type SqliteRow = Record<string, SqliteValue>;
type SqliteInput = SQLInputValue | undefined;
type SqliteParameters = Array<SqliteInput | readonly SqliteInput[] | Readonly<Record<string, SqliteInput>>>;

export class SqliteStatement {
  private readonly parameters: { readonly anonymous: number; readonly named: readonly string[] };

  constructor(private readonly statement: StatementSync, source: string) {
    this.parameters = parameterLayout(source);
    // Convert integers ourselves to retain the previous driver's default Number semantics.
    statement.setReadBigInts(true);
    statement.setAllowBareNamedParameters(false);
  }

  get(...parameters: SqliteParameters): unknown {
    const row = this.statement.get(...this.bind(parameters));
    return row === undefined ? undefined : ordinaryRow(row);
  }

  all(...parameters: SqliteParameters): unknown[] {
    const rows = this.statement.all(...this.bind(parameters));
    return rows.map(ordinaryRow);
  }

  run(...parameters: SqliteParameters): { changes: number; lastInsertRowid: number } {
    const result = this.statement.run(...this.bind(parameters));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  private bind(parameters: SqliteParameters): [Record<string, SQLInputValue>, ...SQLInputValue[]] {
    let named: Readonly<Record<string, SqliteInput>> | undefined;
    const anonymous: SQLInputValue[] = [];
    for (const parameter of parameters) {
      if (Array.isArray(parameter)) {
        for (const value of parameter) anonymous.push(inputValue(value));
      } else if (isNamedParameter(parameter)) {
        const prototype: unknown = Object.getPrototypeOf(parameter);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Named parameters can only be passed within plain objects");
        }
        named ??= parameter;
      } else {
        anonymous.push(inputValue(parameter));
      }
    }
    if (anonymous.length !== this.parameters.anonymous) {
      throw new RangeError(anonymous.length < this.parameters.anonymous
        ? "Too few parameter values were provided"
        : "Too many parameter values were provided");
    }
    const bound: Record<string, SQLInputValue> = {};
    if (this.parameters.named.length > 0 && named === undefined) {
      throw new TypeError("Missing named parameters");
    }
    for (const name of this.parameters.named) {
      const key = name.slice(1);
      if (named === undefined || !Object.hasOwn(named, key)) {
        throw new RangeError(`Missing named parameter "${key}"`);
      }
      bound[name] = inputValue(named[key]);
    }
    return [bound, ...anonymous];
  }
}

function isNamedParameter(parameter: SqliteParameters[number]): parameter is Readonly<Record<string, SqliteInput>> {
  return typeof parameter === "object" && parameter !== null && !ArrayBuffer.isView(parameter) && !Array.isArray(parameter);
}

function inputValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("SQLite3 can only bind numbers, strings, bigints, buffers, and null");
}

export class SqliteDatabase {
  private readonly connection: DatabaseSync;

  constructor(path: string) {
    this.connection = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 5000,
    });
  }

  exec(sql: string): this {
    this.connection.exec(sql);
    return this;
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.connection.prepare(sql), sql);
  }

  pragma(source: string, options?: { readonly simple?: boolean }): SqliteRow[] | SqliteValue | undefined {
    const rows = this.connection.prepare(`PRAGMA ${source}`).all().map(ordinaryRow);
    return options?.simple === true ? Object.values(rows[0] ?? {})[0] : rows;
  }

  transaction<Args extends unknown[], Result>(work: (...args: Args) => Result): (...args: Args) => Result {
    if (types.isAsyncFunction(work)) {
      throw new TypeError("SQLite transaction callbacks must be synchronous");
    }
    return (...args) => {
      const nested = this.connection.isTransaction;
      this.connection.exec(nested ? "SAVEPOINT ghcg_transaction" : "BEGIN");
      try {
        const result = work(...args);
        if (result !== null && (typeof result === "object" || typeof result === "function")
          && "then" in result && typeof result.then === "function") {
          throw new TypeError("SQLite transaction results must be synchronous");
        }
        this.connection.exec(nested ? "RELEASE ghcg_transaction" : "COMMIT");
        return result;
      } catch (error: unknown) {
        if (this.connection.isOpen && this.connection.isTransaction) {
          try {
            this.connection.exec(nested ? "ROLLBACK TO ghcg_transaction; RELEASE ghcg_transaction" : "ROLLBACK");
          } catch (rollbackError: unknown) {
            throw new AggregateError([error, rollbackError], "SQLite transaction rollback failed");
          }
        }
        throw error;
      }
    };
  }

  close(): this {
    if (this.connection.isOpen) {
      this.connection.close();
    }
    return this;
  }
}

// node:sqlite binds omitted parameters as NULL. Count SQLite slots without
// interpreting placeholders inside quoted strings, identifiers, or comments.
function parameterLayout(source: string): { anonymous: number; named: string[] } {
  const tokens = /--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|(\?\d*|[:@$][\w$\u0080-\u{10FFFF}]+)/gu;
  const indexes = new Map<string, number>();
  const names = new Map<number, string>();
  let count = 0;
  for (const match of source.matchAll(tokens)) {
    const parameter = match[1];
    if (parameter === undefined) continue;
    if (parameter === "?") {
      count += 1;
    } else if (parameter.startsWith("?")) {
      const index = Number(parameter.slice(1));
      count = Math.max(count, index);
      if (!names.has(index)) names.set(index, parameter);
    } else {
      let index = indexes.get(parameter);
      if (index === undefined) {
        index = ++count;
        indexes.set(parameter, index);
      }
      if (!names.has(index)) names.set(index, parameter);
    }
  }
  return { anonymous: count - names.size, named: [...names.values()] };
}

function ordinaryRow(row: Record<string, SQLOutputValue>): SqliteRow {
  return Object.fromEntries<SqliteValue>(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value instanceof Uint8Array ? Buffer.from(value) : value,
    ]),
  );
}
