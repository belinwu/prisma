import type {
  Client as LibSqlClientRaw,
  InStatement,
  ResultSet as LibSqlResultSet,
  Transaction as LibSqlTransactionRaw,
} from '@libsql/client'
import type {
  Query,
  Queryable,
  Result,
  SQLDriverAdapter,
  SQLQuery,
  SQLResultSet,
  Transaction,
  TransactionContext,
  TransactionOptions,
} from '@prisma/driver-adapter-utils'
import { Debug, err, ok } from '@prisma/driver-adapter-utils'
import { Mutex } from 'async-mutex'

import { name as packageName } from '../package.json'
import { getColumnTypes, mapRow } from './conversion'

const debug = Debug('prisma:driver-adapter:libsql')

type StdClient = LibSqlClientRaw
type TransactionClient = LibSqlTransactionRaw

const LOCK_TAG = Symbol()

class LibSqlQueryable<ClientT extends StdClient | TransactionClient> implements Queryable<SQLQuery, SQLResultSet> {
  readonly provider = 'sqlite'
  readonly adapterName = packageName;

  [LOCK_TAG] = new Mutex()

  constructor(protected readonly client: ClientT) {}

  /**
   * Execute a query given as SQL, interpolating the given parameters.
   */
  async queryRaw(query: SQLQuery): Promise<Result<SQLResultSet>> {
    const tag = '[js::query_raw]'
    debug(`${tag} %O`, query)

    const ioResult = await this.performIO(query)

    return ioResult.map(({ columns, rows, columnTypes: declaredColumnTypes }) => {
      const columnTypes = getColumnTypes(declaredColumnTypes, rows)

      return {
        kind: 'sql',
        columnNames: columns,
        columnTypes,
        rows: rows.map((row) => mapRow(row, columnTypes)),
      }
    })
  }

  /**
   * Execute a query given as SQL, interpolating the given parameters and
   * returning the number of affected rows.
   * Note: Queryable expects a u64, but napi.rs only supports u32.
   */
  async executeRaw(query: Query): Promise<Result<number>> {
    const tag = '[js::execute_raw]'
    debug(`${tag} %O`, query)

    return (await this.performIO(query)).map(({ rowsAffected }) => rowsAffected ?? 0)
  }

  /**
   * Run a query against the database, returning the result set.
   * Should the query fail due to a connection error, the connection is
   * marked as unhealthy.
   */
  private async performIO(query: Query): Promise<Result<LibSqlResultSet>> {
    const release = await this[LOCK_TAG].acquire()
    try {
      const result = await this.client.execute(query as InStatement)
      return ok(result)
    } catch (e) {
      const error = e as Error
      debug('Error in performIO: %O', error)
      const rawCode = error['rawCode'] ?? e.cause?.['rawCode']
      if (typeof rawCode === 'number') {
        return err({
          kind: 'Sqlite',
          extendedCode: rawCode,
          message: error.message,
        })
      }
      throw error
    } finally {
      release()
    }
  }
}

class LibSqlTransaction extends LibSqlQueryable<TransactionClient> implements Transaction<SQLQuery, SQLResultSet> {
  constructor(client: TransactionClient, readonly options: TransactionOptions, readonly unlockParent: () => void) {
    super(client)
  }

  async commit(): Promise<Result<void>> {
    debug(`[js::commit]`)

    try {
      await this.client.commit()
    } finally {
      this.unlockParent()
    }

    return ok(undefined)
  }

  async rollback(): Promise<Result<void>> {
    debug(`[js::rollback]`)

    try {
      await this.client.rollback()
    } catch (error) {
      debug('error in rollback:', error)
    } finally {
      this.unlockParent()
    }

    return ok(undefined)
  }
}

class LibSqlTransactionContext
  extends LibSqlQueryable<StdClient>
  implements TransactionContext<SQLQuery, SQLResultSet>
{
  constructor(readonly client: StdClient, readonly release: () => void) {
    super(client)
  }

  async startTransaction(): Promise<Result<Transaction<SQLQuery, SQLResultSet>>> {
    const options: TransactionOptions = {
      usePhantomQuery: true,
    }

    const tag = '[js::startTransaction]'
    debug('%s options: %O', tag, options)

    try {
      const tx = await this.client.transaction('deferred')
      return ok(new LibSqlTransaction(tx, options, this.release))
    } catch (e) {
      // note: we only release the lock if creating the transaction fails, it must stay locked otherwise,
      // hence `catch` and rethrowing the error and not `finally`.
      this.release()
      throw e
    }
  }
}

export class PrismaLibSQL extends LibSqlQueryable<StdClient> implements SQLDriverAdapter {
  constructor(client: StdClient) {
    super(client)
  }

  async transactionContext(): Promise<Result<TransactionContext<SQLQuery, SQLResultSet>>> {
    const release = await this[LOCK_TAG].acquire()
    return ok(new LibSqlTransactionContext(this.client, release))
  }
}
