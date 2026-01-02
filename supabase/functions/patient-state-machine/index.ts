import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Valid state transition rules
const STATE_MACHINE = {
  registered: ['at_triage', 'cancelled'],
  at_triage: ['vitals_taken', 'cancelled'],
  vitals_taken: ['with_doctor', 'cancelled'],
  with_doctor: ['at_lab', 'at_imaging', 'prescribing', 'admitted', 'cancelled'],
  at_lab: ['results_ready', 'cancelled'],
  at_imaging: ['results_ready', 'cancelled'],
  results_ready: ['with_doctor', 'cancelled'],
  prescribing: ['at_pharmacy', 'discharged', 'cancelled'],
  at_pharmacy: ['discharged', 'cancelled'],
  admitted: ['discharged'],
  discharged: [],
  cancelled: []
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { visitId, targetState, userId, metadata } = await req.json();
    
    console.log(`State transition request: visitId=${visitId}, targetState=${targetState}, userId=${userId}`);
    
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    
    // Get current visit state
    const { data: visit, error: visitError } = await supabase
      .from('visits')
      .select('status, patient_id, journey_timeline')
      .eq('id', visitId)
      .single();
    
    if (visitError) {
      console.error('Error fetching visit:', visitError);
      throw visitError;
    }
    
    const currentState = visit.status || 'registered';
    
    console.log(`Current state: ${currentState}, target state: ${targetState}`);
    
    // Validate transition
    const allowedStates = STATE_MACHINE[currentState as keyof typeof STATE_MACHINE] || [];
    
    if (!allowedStates.includes(targetState)) {
      console.warn(`Invalid transition attempted: ${currentState} → ${targetState}`);
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid transition: ${currentState} → ${targetState}`,
          currentState,
          allowedStates
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }
    
    console.log('Transition is valid, executing...');
    
    // Transition is valid - track in journey_timeline
    const { error: trackError } = await supabase.rpc('append_journey_stage', {
      p_visit_id: visitId,
      p_stage: targetState,
      p_user_id: userId
    });
    
    if (trackError) {
      console.error('Error tracking journey stage:', trackError);
      throw trackError;
    }
    
    // Log to event store
    const { error: eventError } = await supabase.from('patient_status_events').insert({
      visit_id: visitId,
      patient_id: visit.patient_id,
      previous_status: currentState,
      new_status: targetState,
      changed_by: userId,
      metadata
    });
    
    if (eventError) {
      console.error('Error logging to event store:', eventError);
      // Don't fail the entire operation if event logging fails
    }
    
    console.log(`State transition successful: ${currentState} → ${targetState}`);
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        newState: targetState,
        previousState: currentState
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('State machine error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
