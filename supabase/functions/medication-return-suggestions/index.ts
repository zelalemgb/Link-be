import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SupabaseCreateClient = typeof createClient;

interface HandlerDependencies {
  createSupabaseClient?: SupabaseCreateClient;
  fetchImpl?: typeof fetch;
}

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export async function handler(req: Request, deps: HandlerDependencies = {}): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization) {
    return jsonResponse({ success: false, error: "Missing authorization token" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  const patientId = payload["patientId"] as string | undefined;
  const visitId = payload["visitId"] as string | undefined;
  const medicationName = payload["medicationName"] as string | undefined;
  const dosage = payload["dosage"] as string | undefined;
  const frequency = payload["frequency"] as string | undefined;
  const tenantId = (payload["tenant_id"] ?? payload["tenantId"]) as string | undefined;
  const facilityId = (payload["facility_id"] ?? payload["facilityId"]) as string | undefined;

  if (!tenantId || typeof tenantId !== "string") {
    return jsonResponse({ success: false, error: "tenant_id is required" }, 400);
  }

  if (!facilityId || typeof facilityId !== "string") {
    return jsonResponse({ success: false, error: "facility_id is required" }, 400);
  }

  if (!patientId || !visitId || !medicationName) {
    return jsonResponse({ success: false, error: "patientId, visitId, and medicationName are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Supabase URL or anon key is not configured");
    return jsonResponse({ success: false, error: "Supabase configuration is missing" }, 500);
  }

  if (!lovableApiKey) {
    console.error("LOVABLE_API_KEY is not configured");
    return jsonResponse({ success: false, error: "AI gateway configuration is missing" }, 500);
  }

  const createSupabase = deps.createSupabaseClient ?? createClient;
  const supabase = createSupabase(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: authorization },
    },
  });

  try {
    const { data: patient, error: patientError } = await supabase
      .from("patients")
      .select("id, tenant_id, age, gender")
      .eq("id", patientId)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (patientError) {
      console.error("Error fetching patient:", patientError);
      return jsonResponse({ success: false, error: "Unable to fetch patient details" }, 500);
    }

    if (!patient) {
      return jsonResponse({ success: false, error: "Patient not found" }, 404);
    }

    const { data: visit, error: visitError } = await supabase
      .from("visits")
      .select("id, tenant_id, facility_id, patient_id, complaint, diagnosis, assessment_summary")
      .eq("id", visitId)
      .eq("tenant_id", tenantId)
      .eq("facility_id", facilityId)
      .maybeSingle();

    if (visitError) {
      console.error("Error fetching visit:", visitError);
      return jsonResponse({ success: false, error: "Unable to fetch visit details" }, 500);
    }

    if (!visit) {
      return jsonResponse({ success: false, error: "Visit not found" }, 404);
    }

    if (visit.patient_id !== patientId) {
      return jsonResponse({ success: false, error: "Visit does not belong to the provided patient" }, 403);
    }

    const medicationQuery = supabase
      .from("medication_orders")
      .select("medication_name, generic_name, dosage, frequency")
      .eq("visit_id", visitId)
      .eq("tenant_id", tenantId);

    const medicationQueryWithFilter = medicationName
      ? medicationQuery.neq("medication_name", medicationName)
      : medicationQuery;

    const { data: otherMeds, error: otherMedsError } = await medicationQueryWithFilter;

    if (otherMedsError) {
      console.error("Error fetching other medications:", otherMedsError);
      return jsonResponse({ success: false, error: "Unable to fetch other medications" }, 500);
    }

    const { data: labOrders, error: labOrdersError } = await supabase
      .from("lab_orders")
      .select("test_name, result")
      .eq("visit_id", visitId)
      .eq("tenant_id", tenantId)
      .eq("status", "completed");

    if (labOrdersError) {
      console.error("Error fetching lab orders:", labOrdersError);
      return jsonResponse({ success: false, error: "Unable to fetch lab orders" }, 500);
    }

    const systemPrompt = `You are a clinical pharmacist AI assistant helping identify potential reasons for returning a medication order to the prescriber.
Analyze the patient context and suggest specific, actionable reasons why this medication might need to be returned.
Focus on drug interactions, contraindications, dosage concerns, duplicate therapy, and clinical appropriateness.
Be concise and clinical in your suggestions.`;

    const patientSummary = `Age: ${patient.age ?? "Unknown"}, Gender: ${patient.gender ?? "Unknown"}`;
    const medicationSummary = `${medicationName}${dosage ? ` ${dosage}` : ""}${frequency ? ` ${frequency}` : ""}`.trim();
    const concurrentMedications = (otherMeds ?? [])
      .map((med) => `- ${med.medication_name}${med.dosage ? ` ${med.dosage}` : ""}${med.frequency ? ` ${med.frequency}` : ""}`)
      .join("\n");
    const labSummary = (labOrders ?? [])
      .map((lab) => `- ${lab.test_name}: ${lab.result ?? "Result unavailable"}`)
      .join("\n");

    const userPrompt = `Patient Summary:
- ${patientSummary}

Visit Context:
- Chief Complaint: ${visit.complaint ?? "Not provided"}
- Diagnosis: ${visit.diagnosis ?? "Not provided"}
- Assessment: ${visit.assessment_summary ?? "Not provided"}

Medication Under Review:
- ${medicationSummary || "Details unavailable"}

Concurrent Medications:
${concurrentMedications || "- None reported"}

Relevant Lab Results:
${labSummary || "- No completed lab results available"}

Provide 3-5 specific reasons why this medication order might need to be returned to the prescriber. Each reason should be a brief, actionable statement (1-2 sentences max). Avoid mentioning any patient-identifying information.`;

    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "suggest_return_reasons",
              description: "Return 3-5 specific clinical reasons for returning the medication",
              parameters: {
                type: "object",
                properties: {
                  suggestions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        reason: { type: "string" },
                        severity: { type: "string", enum: ["low", "moderate", "high"] },
                      },
                      required: ["reason", "severity"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["suggestions"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "suggest_return_reasons" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return jsonResponse({ success: false, error: "Rate limit exceeded. Please try again later." }, 429);
      }
      if (response.status === 402) {
        return jsonResponse({ success: false, error: "Payment required. Please add funds to your Lovable AI workspace." }, 402);
      }

      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      return jsonResponse({ success: false, error: "AI gateway error" }, 502);
    }

    const result = await response.json();
    const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) {
      return jsonResponse({ success: false, error: "No suggestions received from AI" }, 502);
    }

    const suggestions = JSON.parse(toolCall.function.arguments);

    return jsonResponse({ success: true, suggestions: suggestions.suggestions ?? [] });
  } catch (error) {
    console.error("Error generating suggestions:", error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
}

if (import.meta.main) {
  serve((req) => handler(req));
}
