import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../../src/persistence/sqlite.js";

describe("synchronous SQLite interface", () => {
  it("returns ordinary rows, buffers, and numeric write results without Promises", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      expect(database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT, payload BLOB)")).toBe(database);
      const insert = database.prepare("INSERT INTO sample (value, payload) VALUES (?, ?)");
      expect(insert.run("first", Buffer.from([0, 255]))).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(insert.run(null, null)).toEqual({ changes: 1, lastInsertRowid: 2 });
      const row = database.prepare("SELECT * FROM sample WHERE id = ?").get(1);
      expect(row).toEqual({ id: 1, value: "first", payload: Buffer.from([0, 255]) });
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(row).toMatchObject({ payload: expect.any(Buffer) });
      expect(database.prepare("SELECT id FROM sample ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
      expect(database.prepare("SELECT * FROM sample WHERE id = ?").get(99)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("commits synchronous callback results and rolls back callback failures", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE sample (value TEXT)");
      const write = database.transaction((value: string) => {
        database.prepare("INSERT INTO sample VALUES (?)").run(value);
        return value.length;
      });
      expect(write("saved")).toBe(5);
      const failure = new Error("transaction rejected");
      expect(() => database.transaction(() => {
        database.prepare("INSERT INTO sample VALUES (?)").run("discarded");
        throw failure;
      })()).toThrow(failure);
      expect(database.prepare("SELECT value FROM sample").all()).toEqual([{ value: "saved" }]);
      expect(write("next")).toBe(4);
    } finally {
      database.close();
    }
  });

  it("uses nested savepoints without committing or discarding the outer transaction", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE sample (value TEXT)");
      const insert = database.prepare("INSERT INTO sample VALUES (?)");
      const failure = new Error("nested failure");
      database.transaction(() => {
        insert.run("before");
        expect(() => database.transaction(() => {
          insert.run("discarded");
          throw failure;
        })()).toThrow(failure);
        database.transaction(() => insert.run("after"))();
      })();
      expect(() => database.transaction(() => {
        database.transaction(() => insert.run("also discarded"))();
        throw failure;
      })()).toThrow(failure);
      expect(database.prepare("SELECT value FROM sample").all()).toEqual([{ value: "before" }, { value: "after" }]);
    } finally {
      database.close();
    }
  });

  it("keeps row and simple PRAGMA results synchronous", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(() => database.prepare("SELECT \"literal\"")).toThrow(/no such column/u);
      expect(database.pragma("foreign_keys = ON")).toEqual([]);
      expect(database.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
      expect(database.pragma("synchronous = FULL", { simple: true })).toBeUndefined();
      expect(database.pragma("synchronous", { simple: true })).toBe(2);
    } finally {
      database.close();
    }
  });

  it("preserves the original error when SQLite has already rolled back the transaction", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec(`
        CREATE TABLE sample (value TEXT);
        CREATE TRIGGER reject_sample BEFORE INSERT ON sample WHEN NEW.value = 'reject'
        BEGIN SELECT RAISE(ROLLBACK, 'synthetic write rejected'); END;
      `);
      expect(() => database.transaction(() => {
        database.prepare("INSERT INTO sample VALUES (?)").run("discarded");
        database.prepare("INSERT INTO sample VALUES (?)").run("reject");
      })()).toThrow("synthetic write rejected");
      expect(database.prepare("SELECT * FROM sample").all()).toEqual([]);
      database.transaction(() => database.prepare("INSERT INTO sample VALUES (?)").run("accepted"))();
      expect(database.prepare("SELECT * FROM sample").all()).toEqual([{ value: "accepted" }]);
    } finally {
      database.close();
    }
  });

  it("rejects deferred transaction work instead of committing a Promise", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE sample (value TEXT)");
      let invoked = false;
      expect(() => database.transaction(async () => {
        invoked = true;
        await Promise.resolve();
        database.prepare("INSERT INTO sample VALUES (?)").run("too late");
      })).toThrow(/synchronous/u);
      expect(invoked).toBe(false);
      expect(() => database.transaction(() => {
        database.prepare("INSERT INTO sample VALUES (?)").run("discarded");
        return Promise.resolve("not a synchronous result");
      })()).toThrow(/synchronous/u);
      expect(database.prepare("SELECT * FROM sample").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("retains default numeric results for SQLite integers outside the safe integer range", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
      expect(database.prepare("INSERT INTO sample VALUES (?)").run(9_007_199_254_740_993n))
        .toEqual({ changes: 1, lastInsertRowid: 9_007_199_254_740_992 });
      expect(database.prepare("SELECT id FROM sample").get()).toEqual({ id: 9_007_199_254_740_992 });
    } finally {
      database.close();
    }
  });

  it("binds named parameters alongside positional values and ignores unused named keys", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE sample (id INTEGER, value TEXT)");
      expect(database.prepare("INSERT INTO sample VALUES (@id, ?)").run({ id: 3, unused: "ignored" }, "named"))
        .toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(database.prepare("SELECT * FROM sample WHERE id = @id").get({ id: 3, unused: null }))
        .toEqual({ id: 3, value: "named" });
      expect(database.prepare("SELECT id FROM sample WHERE id >= @min").all({ min: 1 })).toEqual([{ id: 3 }]);
    } finally {
      database.close();
    }
  });

  it("reports the original failure together with a failed rollback", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const failure = new Error("transaction failed");
      let observed: unknown;
      try {
        database.transaction(() => database.transaction(() => {
          database.exec("ROLLBACK; BEGIN");
          throw failure;
        })())();
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(AggregateError);
      expect(observed).toMatchObject({
        errors: [failure, expect.objectContaining({ message: expect.stringContaining("savepoint") })],
      });
      expect(database.transaction(() => "recovered")()).toBe("recovered");
    } finally {
      database.close();
    }
  });

  it("closes idempotently while rejecting subsequent database work", () => {
    const database = new SqliteDatabase(":memory:");
    const statement = database.prepare("SELECT 1");
    expect(database.close()).toBe(database);
    expect(database.close()).toBe(database);
    expect(() => statement.get()).toThrow();
    expect(() => database.exec("SELECT 1")).toThrow();
    expect(() => database.transaction(() => undefined)()).toThrow();
  });

  it("rolls back a commit failure before allowing the next transaction", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      database.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      `);
      let completedCallback = false;
      expect(() => database.transaction(() => {
        database.prepare("INSERT INTO child VALUES (?)").run(7);
        completedCallback = true;
      })()).toThrow(/FOREIGN KEY/u);
      expect(completedCallback).toBe(true);
      expect(database.prepare("SELECT * FROM child").all()).toEqual([]);
      database.transaction(() => {
        database.prepare("INSERT INTO parent VALUES (?)").run(7);
        database.prepare("INSERT INTO child VALUES (?)").run(7);
      })();
      expect(database.prepare("SELECT * FROM child").all()).toEqual([{ parent_id: 7 }]);
    } finally {
      database.close();
    }
  });

  it("rejects omitted and excess bindings before executing a statement", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec("CREATE TABLE sample (value TEXT)");
      const positional = database.prepare("INSERT INTO sample VALUES (?)");
      expect(() => positional.run()).toThrow(RangeError);
      expect(() => positional.run("one", "extra")).toThrow(RangeError);
      const named = database.prepare("INSERT INTO sample VALUES (@value)");
      expect(() => named.run()).toThrow(TypeError);
      expect(() => named.run({ unrelated: "not the requested value" })).toThrow(RangeError);
      expect(() => named.run({ "@value": "not a bare key" })).toThrow(RangeError);
      expect(database.prepare("SELECT * FROM sample").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("retains array, mixed-order named, and undefined binding forms", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      expect(database.prepare("SELECT ? AS a, ? AS b, ? AS c").get(["first", 7], undefined))
        .toEqual({ a: "first", b: 7, c: null });
      expect(database.prepare("SELECT ? AS a, @value AS b, ? AS c").get(7, { value: "named" }, 9))
        .toEqual({ a: 7, b: "named", c: 9 });
      expect(database.prepare("SELECT @value AS a").get({ value: undefined })).toEqual({ a: null });
      const sparse: number[] = [];
      sparse.length = 2;
      sparse[1] = 7;
      expect(database.prepare("SELECT ? AS a, ? AS b").get(sparse)).toEqual({ a: null, b: 7 });
    } finally {
      database.close();
    }
  });

  it("recognizes non-ASCII SQLite parameter names rather than silently binding NULL", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const name = "\u{1f916}";
      const statement = database.prepare(`SELECT :${name} AS value`);
      expect(statement.get({ [name]: "unicode" })).toEqual({ value: "unicode" });
      expect(() => statement.get({})).toThrow(RangeError);
    } finally {
      database.close();
    }
  });

  it("distinguishes parameter slots from quoted SQL and comments", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const statement = database.prepare(`
        SELECT 'it''s ? @ignored' AS literal, ? AS "a""?b",
               @value AS \`?\`, :value AS [@name]
        /* ? :hidden */ -- ? $hidden
      `);
      expect(statement.get(7, { value: "named" })).toEqual({
        literal: "it's ? @ignored",
        "a\"?b": 7,
        "?": "named",
        "@name": "named",
      });
      expect(database.prepare("SELECT ?1 AS a, ?2 AS b").get({ 1: "first", 2: 7 }))
        .toEqual({ a: "first", b: 7 });
      expect(database.prepare("SELECT @v AS a, :v AS b, $v AS c").get({ v: "same" }))
        .toEqual({ a: "same", b: "same", c: "same" });
    } finally {
      database.close();
    }
  });
});
