import { assert, assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { handler } from "../index.ts";

type SupabaseResult<T> = { data: T | null; error: { message: string } | null };

type TableResponses = Record<string, SupabaseResult<unknown>>;

type QueryBuilder<T> = {
  select: () => QueryBuilder<T>;
  eq: (_column: string, _value: unknown) => QueryBuilder<T>;
  neq: (_column: string, _value: unknown) => QueryBuilder<T>;
  order: (_column: string, _options?: unknown) => QueryBuilder<T>;
  maybeSingle: () => Promise<SupabaseResult<T>>;
  then: <TResult1 = SupabaseResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SupabaseResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
};

function createMockQueryBuilder<T>(result: SupabaseResult<T>): QueryBuilder<T> {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    neq() {
      return this;
    },
    order() {
      return this;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
    then(onfulfilled, onrejected) {
      return Promise.resolve(result).then(onfulfilled ?? undefined, onrejected ?? undefined);
    },
  };
}

function createMockSupabase(responses: TableResponses) {
  return {
    from(table: string) {
      const result = responses[table] ?? { data: null, error: null };
      return createMockQueryBuilder(result);
    },
  };
}

Deno.test("handler returns AI suggestions when data is available", async () => {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  Deno.env.set("LOVABLE_API_KEY", "lovable-key");

  const responses: TableResponses = {
    patients: { data: { id: "patient-1", tenant_id: "tenant-1", age: 45, gender: "Female" }, error: null },
    visits: {
      data: {
        id: "visit-1",
        tenant_id: "tenant-1",
        facility_id: "facility-1",
        patient_id: "patient-1",
        complaint: "Headache",
        diagnosis: "Migraine",
        assessment_summary: "Chronic condition",
      },
      error: null,
    },
    medication_orders: {
      data: [
        { medication_name: "Drug B", dosage: "5mg", frequency: "daily" },
      ],
      error: null,
    },
    lab_orders: {
      data: [
        { test_name: "CBC", result: "normal" },
      ],
      error: null,
    },
  };

  const authorizationHeaders: Record<string, string> = {};

  type CreateClientOptions = {
    global?: {
      headers?: Record<string, string>;
    };
  };

  const mockCreateClient = (_url: string, _key: string, options?: CreateClientOptions) => {
    authorizationHeaders["Authorization"] = options?.global?.headers?.Authorization ?? "";
    return createMockSupabase(responses);
  };

  const fetchCalls: Array<{ body: Record<string, unknown> }> = [];
  const fetchStub: typeof fetch = (_input, init) => {
    const parsed = JSON.parse((init?.body as string) ?? "{}");
    fetchCalls.push({ body: parsed });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({
                        suggestions: [
                          { reason: "Reason 1", severity: "high" },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const request = new Request("https://example.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer user-token",
    },
    body: JSON.stringify({
      patientId: "patient-1",
      visitId: "visit-1",
      medicationName: "Drug A",
      dosage: "10mg",
      frequency: "daily",
      tenantId: "tenant-1",
      facilityId: "facility-1",
    }),
  });

  const response = await handler(request, {
    createSupabaseClient: mockCreateClient,
    fetchImpl: fetchStub,
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.success, true);
  assertEquals(body.suggestions.length, 1);
  assertEquals(authorizationHeaders["Authorization"], "Bearer user-token");

  assertEquals(fetchCalls.length, 1);
  const messages = fetchCalls[0].body.messages as Array<{ content?: string }>;
  const aiPrompt = messages?.[1]?.content ?? "";
  assert(!aiPrompt.includes("patient-1"));
});

Deno.test("handler returns 404 when patient is not found", async () => {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  Deno.env.set("LOVABLE_API_KEY", "lovable-key");

  const responses: TableResponses = {
    patients: { data: null, error: null },
  };

  let fetchCalled = false;
  const fetchStub: typeof fetch = () => {
    fetchCalled = true;
    return Promise.resolve(new Response("", { status: 500 }));
  };

  const request = new Request("https://example.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer user-token",
    },
    body: JSON.stringify({
      patientId: "missing-patient",
      visitId: "visit-1",
      medicationName: "Drug A",
      tenantId: "tenant-1",
      facilityId: "facility-1",
    }),
  });

  const response = await handler(request, {
    createSupabaseClient: (_url, _key, _options) => createMockSupabase(responses),
    fetchImpl: fetchStub,
  });

  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.success, false);
  assertEquals(body.error, "Patient not found");
  assertEquals(fetchCalled, false);
});
