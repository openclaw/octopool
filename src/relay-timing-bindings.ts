import { relayTiming } from "./relay-timing";

const databases = new WeakMap<D1Database, D1Database>();
const originalDatabases = new WeakMap<D1Database, D1Database>();

export function timingD1Identity(db: D1Database): D1Database {
  return originalDatabases.get(db) ?? db;
}

// Observe binding invocations without replacing their promises or receivers.
// DO-internal D1/SQLite operations belong to native traces, not d1_ops.
export function withTimingBindings(env: Env): Env {
  let db = databases.get(env.DB);
  if (db === undefined) {
    db = timedD1(env.DB);
    databases.set(env.DB, db);
    originalDatabases.set(db, timingD1Identity(env.DB));
  }
  return {
    ...env,
    DB: db,
    POOL_COORDINATOR: timedNamespace(env.POOL_COORDINATOR),
    POLICY_COORDINATOR: timedNamespace(env.POLICY_COORDINATOR),
    BACKEND_ADMISSION: timedNamespace(env.BACKEND_ADMISSION),
  };
}

function timedD1<T extends D1Database | D1DatabaseSession>(db: T): T {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const statement = (real: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(real, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (["first", "all", "run", "raw"].includes(String(key))) relayTiming()?.count("d1_ops");
          return Reflect.apply(value, target, args);
        };
      },
    });
    originals.set(wrapped, real);
    return wrapped;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => statement(target.prepare(sql));
      if (key === "withSession" && "withSession" in target)
        return (...args: Parameters<D1Database["withSession"]>) =>
          timedD1(target.withSession(...args));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          relayTiming()?.count("d1_ops");
          return target.batch(statements.map((item) => originals.get(item) ?? item));
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function timedNamespace<T extends DurableObjectNamespace>(namespace: T): T {
  return new Proxy(namespace, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value === "function" && (key === "get" || key === "getByName"))
        return (...args: unknown[]) => {
          const stub = Reflect.apply(value, target, args) as DurableObjectStub;
          return new Proxy(stub, {
            get(real, method) {
              const rpc = Reflect.get(real, method, real);
              if (typeof rpc !== "function") return rpc;
              return (...params: unknown[]) => {
                relayTiming()?.count("do_calls");
                return Reflect.apply(rpc, real, params);
              };
            },
          });
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
