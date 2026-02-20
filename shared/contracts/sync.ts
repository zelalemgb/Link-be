export const SYNC_OP_TYPES = ['upsert', 'delete'] as const;

export type SyncOpType = (typeof SYNC_OP_TYPES)[number];

export type SyncOp = {
  opId: string;
  entityType: string;
  entityId: string;
  opType: SyncOpType;
  data?: Record<string, unknown> | null;
  clientCreatedAt: string;
};

export type SyncPushRequest = {
  facilityId: string;
  deviceId: string;
  ops: SyncOp[];
};

export type SyncPushResponse = {
  serverTime: string;
  results: Array<{
    opId: string;
    status: 'ingested' | 'duplicate';
  }>;
};

export type SyncPullRequest = {
  facilityId: string;
  cursor?: string | null;
  limit?: number | null;
};

export type SyncPullResponse = {
  serverTime: string;
  cursor: string | null;
  hasMore: boolean;
  ops: Array<{
    seq: number;
    opId: string;
    deviceId: string;
    entityType: string;
    entityId: string;
    opType: SyncOpType;
    data: Record<string, unknown> | null;
    clientCreatedAt: string;
    serverCreatedAt: string;
  }>;
};

export type SyncContractError = {
  code: string;
  message: string;
};

