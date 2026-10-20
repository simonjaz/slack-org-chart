import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

export const prisma = new PrismaClient();

// Runs fn in a transaction scoped to one workspace. Row-level security in
// Postgres hides every other workspace's rows, so a missing where clause
// cannot leak another company's people.
export async function withTenant<T>(
  teamId: string,
  fn: (tx: Tx) => Promise<T>,
  db: PrismaClient = prisma,
): Promise<T> {
  if (!teamId) throw new Error('withTenant needs a team id');
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.team_id', ${teamId}, true)`;
      return fn(tx);
    },
    { timeout: 30_000 },
  );
}

// Cross-workspace access. Only for the scheduler and installation lookups.
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>, db: PrismaClient = prisma): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.system', 'on', true)`;
    return fn(tx);
  });
}
