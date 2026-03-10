type SupabaseQueryResult = {
  data: any;
  error: any;
  count?: number | null;
};

type SupabaseQueryBuilder = {
  select: (..._args: any[]) => SupabaseQueryBuilder;
  eq: (..._args: any[]) => SupabaseQueryBuilder;
  is: (..._args: any[]) => SupabaseQueryBuilder;
  neq: (..._args: any[]) => SupabaseQueryBuilder;
  gt: (..._args: any[]) => SupabaseQueryBuilder;
  gte: (..._args: any[]) => SupabaseQueryBuilder;
  lt: (..._args: any[]) => SupabaseQueryBuilder;
  lte: (..._args: any[]) => SupabaseQueryBuilder;
  in: (..._args: any[]) => SupabaseQueryBuilder;
  or: (..._args: any[]) => SupabaseQueryBuilder;
  not: (..._args: any[]) => SupabaseQueryBuilder;
  match: (..._args: any[]) => SupabaseQueryBuilder;
  order: (..._args: any[]) => SupabaseQueryBuilder;
  limit: (..._args: any[]) => SupabaseQueryBuilder;
  range: (..._args: any[]) => SupabaseQueryBuilder;
  maybeSingle: () => Promise<SupabaseQueryResult>;
  single: () => Promise<SupabaseQueryResult>;
  insert: (..._args: any[]) => SupabaseQueryBuilder;
  update: (..._args: any[]) => SupabaseQueryBuilder;
  delete: (..._args: any[]) => SupabaseQueryBuilder;
  upsert: (..._args: any[]) => SupabaseQueryBuilder;
  then: Promise<SupabaseQueryResult>['then'];
};

const createQueryBuilder = (result?: Partial<SupabaseQueryResult>): SupabaseQueryBuilder => {
  const resolvedResult: SupabaseQueryResult = {
    data: [],
    error: null,
    count: 0,
    ...result,
  };

  const builder: SupabaseQueryBuilder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    neq: () => builder,
    gt: () => builder,
    gte: () => builder,
    lt: () => builder,
    lte: () => builder,
    in: () => builder,
    or: () => builder,
    not: () => builder,
    match: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    maybeSingle: async () => ({ ...resolvedResult }),
    single: async () => ({ ...resolvedResult }),
    insert: () => builder,
    update: () => builder,
    delete: () => builder,
    upsert: () => builder,
    then: (onFulfilled, onRejected) => Promise.resolve({ ...resolvedResult }).then(onFulfilled, onRejected),
  };

  return builder;
};

const createSupabaseMock = () => ({
  from: () => createQueryBuilder(),
  rpc: async () => ({ data: null, error: null }),
  auth: {
    getUser: async () => ({ data: { user: null }, error: null }),
    admin: {
      getUserById: async () => ({ data: { user: null }, error: null }),
      listUsers: async () => ({ data: { users: [] }, error: null }),
      createUser: async () => ({ data: { user: null }, error: null }),
      deleteUser: async () => ({ data: null, error: null }),
    },
  },
});

declare global {
  // eslint-disable-next-line no-var
  var __SUPABASE_ADMIN_MOCK__: unknown;
}

process.env.NODE_ENV = 'test';
process.env.PATIENT_SESSION_SECRET = process.env.PATIENT_SESSION_SECRET || 'test-patient-secret';
process.env.EMAIL_VERIFICATION_CODE_SECRET =
  process.env.EMAIL_VERIFICATION_CODE_SECRET || 'test-email-verification-secret';

if (!globalThis.__SUPABASE_ADMIN_MOCK__) {
  globalThis.__SUPABASE_ADMIN_MOCK__ = createSupabaseMock();
}

export {};
