import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type MethodAllocation = {
  payment_method: string;
  amount: number;
  reference_number?: string | null;
  notes?: string | null;
  transaction_date?: string | null;
};

type PaymentRequest = {
  paymentId?: string;
  cashierId?: string;
  methodAllocations?: MethodAllocation[];
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
    ...init,
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Supabase credentials are not configured for payments function");
    return jsonResponse({ error: "Payments service misconfigured" }, { status: 500 });
  }

  try {
    const payload: PaymentRequest = await req.json();

    if (!payload.paymentId || typeof payload.paymentId !== "string") {
      return jsonResponse({ error: "paymentId is required" }, { status: 400 });
    }

    if (!payload.cashierId || typeof payload.cashierId !== "string") {
      return jsonResponse({ error: "cashierId is required" }, { status: 400 });
    }

    if (!Array.isArray(payload.methodAllocations) || payload.methodAllocations.length === 0) {
      return jsonResponse({ error: "methodAllocations must contain at least one entry" }, { status: 400 });
    }

    const normalizedAllocations: MethodAllocation[] = payload.methodAllocations.map((allocation, index) => {
      if (!allocation || typeof allocation !== "object") {
        throw new Error(`Allocation at index ${index} must be an object`);
      }

      const method = typeof allocation.payment_method === "string" ? allocation.payment_method.trim() : "";
      if (!method) {
        throw new Error(`payment_method is required for allocation at index ${index}`);
      }

      const amount = Number(allocation.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`amount must be a positive number for allocation at index ${index}`);
      }

      const reference = typeof allocation.reference_number === "string" ? allocation.reference_number.trim() : allocation.reference_number ?? null;
      const notes = typeof allocation.notes === "string" ? allocation.notes.trim() : allocation.notes ?? null;
      const transactionDate = allocation.transaction_date ?? null;

      if (transactionDate && Number.isNaN(Date.parse(transactionDate))) {
        throw new Error(`transaction_date must be ISO 8601 formatted for allocation at index ${index}`);
      }

      return {
        payment_method: method,
        amount,
        reference_number: reference || null,
        notes: notes || null,
        transaction_date: transactionDate,
      };
    });

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data, error } = await supabase.rpc("apply_payment_method_allocations", {
      payment_id: payload.paymentId,
      cashier_id: payload.cashierId,
      method_allocations: normalizedAllocations,
    });

    if (error) {
      console.error("Failed to apply payment method allocations", error);
      const status = error.message.includes("not found") ? 404 : 400;
      return jsonResponse({ error: error.message }, { status });
    }

    return jsonResponse({ success: true, result: data });
  } catch (error) {
    console.error("Unexpected error in payments function", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ error: message }, { status: 400 });
  }
});
