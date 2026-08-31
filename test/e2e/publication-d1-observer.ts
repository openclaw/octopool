// Thin transport gate: all decisions remain in the actual canonical SQL.
// first() is projected from native all() so tests can observe native metadata.
export function observePublicationD1(
  db: D1Database,
  hooks: {
    before?: (sql: string, values: unknown[]) => Promise<void>;
    after?: (sql: string, values: unknown[], result: D1Result) => Promise<void>;
  },
) {
  const statements = new WeakMap<
    object,
    { sql: string; values: unknown[]; real: D1PreparedStatement }
  >();
  const prepare = (
    sql: string,
    values: unknown[] = [],
    connection: Pick<D1Database, "prepare"> = db,
  ): D1PreparedStatement => {
    const real = values.length ? connection.prepare(sql).bind(...values) : connection.prepare(sql);
    const statement = new Proxy(real, {
      get(target, key) {
        if (key === "bind") return (...bound: unknown[]) => prepare(sql, bound, connection);
        if (key === "first" || key === "all" || key === "run")
          return async (column?: string) => {
            await hooks.before?.(sql, values);
            const result = await target.all();
            await hooks.after?.(sql, values, result);
            if (key !== "first") return result;
            const row = result.results[0] ?? null;
            return column === undefined || row === null ? row : row[column];
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statements.set(statement, { sql, values, real });
    return statement;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return prepare;
      if (key === "withSession")
        return (...args: Parameters<typeof target.withSession>) => {
          const session = target.withSession(...args);
          return new Proxy(session, {
            get(real, method) {
              if (method === "prepare") return (sql: string) => prepare(sql, [], real);
              const value = Reflect.get(real, method, real);
              return typeof value === "function" ? value.bind(real) : value;
            },
          });
        };
      if (key === "batch")
        return async (input: D1PreparedStatement[]) => {
          const descriptions = input.map((statement) => statements.get(statement)!);
          for (const { sql, values } of descriptions) await hooks.before?.(sql, values);
          const results = await target.batch(descriptions.map(({ real }) => real));
          for (let i = 0; i < results.length; i++)
            await hooks.after?.(descriptions[i]!.sql, descriptions[i]!.values, results[i]!);
          return results;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
