export function observeD1Batches(
  db: D1Database,
  onBatch: (statements: D1PreparedStatement[]) => void,
): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          onBatch(statements);
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
