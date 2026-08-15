import { constants as sqliteConstants, type DatabaseSync } from 'node:sqlite';

const AUTHORIZATION_FUNCTION = 'wmb_write_dispatch_authorized';
const WRITE_REQUIRES_DISPATCH = 'WMB_WRITE_REQUIRES_COMMAND_DISPATCH';

type AuthorizationPredicate = () => boolean;
type GuardBinding = {
  readonly isAuthorized: AuthorizationPredicate;
  readonly guardedTables: Set<string>;
  authorizerInstalled: boolean;
};

const installedBindings = new WeakMap<DatabaseSync, GuardBinding>();
const DML_ACTIONS = new Set([
  sqliteConstants.SQLITE_INSERT,
  sqliteConstants.SQLITE_UPDATE,
  sqliteConstants.SQLITE_DELETE
]);
const PRIVILEGED_ACTIONS = new Set([
  sqliteConstants.SQLITE_CREATE_INDEX,
  sqliteConstants.SQLITE_CREATE_TABLE,
  sqliteConstants.SQLITE_CREATE_TEMP_INDEX,
  sqliteConstants.SQLITE_CREATE_TEMP_TABLE,
  sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER,
  sqliteConstants.SQLITE_CREATE_TEMP_VIEW,
  sqliteConstants.SQLITE_CREATE_TRIGGER,
  sqliteConstants.SQLITE_CREATE_VIEW,
  sqliteConstants.SQLITE_DROP_INDEX,
  sqliteConstants.SQLITE_DROP_TABLE,
  sqliteConstants.SQLITE_DROP_TEMP_INDEX,
  sqliteConstants.SQLITE_DROP_TEMP_TABLE,
  sqliteConstants.SQLITE_DROP_TEMP_TRIGGER,
  sqliteConstants.SQLITE_DROP_TEMP_VIEW,
  sqliteConstants.SQLITE_DROP_TRIGGER,
  sqliteConstants.SQLITE_DROP_VIEW,
  sqliteConstants.SQLITE_ALTER_TABLE,
  sqliteConstants.SQLITE_CREATE_VTABLE,
  sqliteConstants.SQLITE_DROP_VTABLE,
  sqliteConstants.SQLITE_REINDEX,
  sqliteConstants.SQLITE_ANALYZE,
  sqliteConstants.SQLITE_TRANSACTION,
  sqliteConstants.SQLITE_SAVEPOINT,
  sqliteConstants.SQLITE_ATTACH,
  sqliteConstants.SQLITE_DETACH
]);

export function installWorkspaceWriteGuard(database: DatabaseSync, isAuthorized: AuthorizationPredicate): void {
  // Workspace-runtime unit tests intentionally use a minimal non-SQLite test double.
  if (typeof database.function !== 'function' || typeof database.exec !== 'function') return;

  let binding = installedBindings.get(database);
  if (binding && binding.isAuthorized !== isAuthorized) throw new Error('WMB_WRITE_GUARD_ALREADY_BOUND');
  if (!binding) {
    binding = { isAuthorized, guardedTables: new Set(), authorizerInstalled: false };
    installedBindings.set(database, binding);
    database.function(AUTHORIZATION_FUNCTION, () => isAuthorized() ? 1 : 0);
  }

  const tables = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;

  for (const { name } of tables) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const triggerName = quoteIdentifier(`wmb_write_guard_${operation.toLowerCase()}_${name}`);
      const tableName = quoteIdentifier(name);
      database.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS ${triggerName}
        BEFORE ${operation} ON ${tableName}
        FOR EACH ROW
        WHEN ${AUTHORIZATION_FUNCTION}() <> 1
        BEGIN
          SELECT RAISE(ABORT, '${WRITE_REQUIRES_DISPATCH}');
        END
      `);
    }
    binding.guardedTables.add(name);
  }

  if (!binding.authorizerInstalled && typeof database.setAuthorizer === 'function') {
    const installedBinding = binding;
    database.setAuthorizer((actionCode, tableName) => {
      if (installedBinding.isAuthorized()) return sqliteConstants.SQLITE_OK;
      if (PRIVILEGED_ACTIONS.has(actionCode)) return sqliteConstants.SQLITE_DENY;
      if (DML_ACTIONS.has(actionCode)) {
        return tableName !== null && installedBinding.guardedTables.has(tableName)
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY;
      }
      return sqliteConstants.SQLITE_OK;
    });
    binding.authorizerInstalled = true;
  }
}


function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
