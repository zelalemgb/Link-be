import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface KPICalculation {
  kpi_code: string
  value: number
  status: 'green' | 'yellow' | 'red'
  numerator?: number
  denominator?: number
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    console.log('[KPI] Starting KPI calculation job...')

    // Parse request body for optional facility_id filter
    let facilityId: string | null = null
    try {
      const body = await req.json()
      facilityId = body.facility_id || null
    } catch {
      // No body provided, calculate for all facilities
    }

    // Get all active facilities (or specific one)
    const facilitiesQuery = supabase
      .from('facilities')
      .select('id, tenant_id, name')
      .eq('activation_status', 'active')

    if (facilityId) {
      facilitiesQuery.eq('id', facilityId)
    }

    const { data: facilities, error: facilitiesError } = await facilitiesQuery

    if (facilitiesError) {
      console.error('[KPI] Error fetching facilities:', facilitiesError)
      throw facilitiesError
    }

    console.log(`[KPI] Processing ${facilities?.length || 0} facilities`)

    const today = new Date().toISOString().split('T')[0]
    const results: { facility: string; kpis: KPICalculation[] }[] = []

    for (const facility of facilities || []) {
      console.log(`[KPI] Calculating KPIs for facility: ${facility.name}`)
      
      const kpis: KPICalculation[] = []

      // 1. Average Wait Time (from check-in to triage)
      const { data: waitTimeData } = await supabase
        .from('visits')
        .select('created_at, status_updated_at, journey_timeline')
        .eq('facility_id', facility.id)
        .gte('visit_date', today)
        .not('status', 'eq', 'registered')

      let avgWaitTime = 0
      let waitCount = 0
      for (const visit of waitTimeData || []) {
        const timeline = visit.journey_timeline as { stages?: { stage: string; end_time?: string }[] } | null
        const triageStage = timeline?.stages?.find((s: any) => s.stage === 'at_triage' && s.end_time)
        if (triageStage?.end_time) {
          const waitMinutes = (new Date(triageStage.end_time).getTime() - new Date(visit.created_at).getTime()) / 60000
          if (waitMinutes > 0 && waitMinutes < 480) { // Cap at 8 hours
            avgWaitTime += waitMinutes
            waitCount++
          }
        }
      }
      avgWaitTime = waitCount > 0 ? Math.round(avgWaitTime / waitCount) : 0
      kpis.push({
        kpi_code: 'AVG_WAIT_TIME',
        value: avgWaitTime,
        status: avgWaitTime <= 15 ? 'green' : avgWaitTime <= 25 ? 'yellow' : 'red',
        numerator: avgWaitTime * waitCount,
        denominator: waitCount
      })

      // 2. Daily Patient Visits
      const { count: visitCount } = await supabase
        .from('visits')
        .select('*', { count: 'exact', head: true })
        .eq('facility_id', facility.id)
        .gte('visit_date', today)

      kpis.push({
        kpi_code: 'DAILY_VISITS',
        value: visitCount || 0,
        status: (visitCount || 0) >= 50 ? 'green' : (visitCount || 0) >= 30 ? 'yellow' : 'red'
      })

      // 3. Visit Completion Rate
      const { count: completedCount } = await supabase
        .from('visits')
        .select('*', { count: 'exact', head: true })
        .eq('facility_id', facility.id)
        .gte('visit_date', today)
        .eq('status', 'completed')

      const completionRate = (visitCount || 0) > 0 
        ? Math.round(((completedCount || 0) / (visitCount || 1)) * 100)
        : 0
      kpis.push({
        kpi_code: 'COMPLETION_RATE',
        value: completionRate,
        status: completionRate >= 85 ? 'green' : completionRate >= 70 ? 'yellow' : 'red',
        numerator: completedCount || 0,
        denominator: visitCount || 0
      })

      // 4. Payment Collection Rate
      const { data: billingData } = await supabase
        .from('billing_items')
        .select('total_amount, payment_status')
        .eq('tenant_id', facility.tenant_id)
        .gte('created_at', `${today}T00:00:00`)

      let totalBilled = 0
      let totalPaid = 0
      for (const item of billingData || []) {
        totalBilled += item.total_amount || 0
        if (item.payment_status === 'paid') {
          totalPaid += item.total_amount || 0
        }
      }
      const collectionRate = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 100) : 0
      kpis.push({
        kpi_code: 'COLLECTION_RATE',
        value: collectionRate,
        status: collectionRate >= 90 ? 'green' : collectionRate >= 80 ? 'yellow' : 'red',
        numerator: totalPaid,
        denominator: totalBilled
      })

      // 5. Daily Revenue
      kpis.push({
        kpi_code: 'DAILY_REVENUE',
        value: Math.round(totalPaid),
        status: totalPaid >= 50000 ? 'green' : totalPaid >= 30000 ? 'yellow' : 'red'
      })

      // 6. Lab Turnaround Time
      const { data: labOrders } = await supabase
        .from('lab_orders')
        .select('created_at, result_entered_at')
        .eq('facility_id', facility.id)
        .gte('created_at', `${today}T00:00:00`)
        .eq('status', 'completed')

      let avgLabTAT = 0
      let labCount = 0
      for (const order of labOrders || []) {
        if (order.result_entered_at) {
          const tat = (new Date(order.result_entered_at).getTime() - new Date(order.created_at).getTime()) / 60000
          if (tat > 0 && tat < 480) {
            avgLabTAT += tat
            labCount++
          }
        }
      }
      avgLabTAT = labCount > 0 ? Math.round(avgLabTAT / labCount) : 0
      kpis.push({
        kpi_code: 'LAB_TAT',
        value: avgLabTAT,
        status: avgLabTAT <= 60 ? 'green' : avgLabTAT <= 90 ? 'yellow' : 'red',
        numerator: avgLabTAT * labCount,
        denominator: labCount
      })

      // 7. Imaging Turnaround Time
      const { data: imagingOrders } = await supabase
        .from('imaging_orders')
        .select('created_at, report_entered_at')
        .eq('facility_id', facility.id)
        .gte('created_at', `${today}T00:00:00`)
        .eq('status', 'completed')

      let avgImagingTAT = 0
      let imagingCount = 0
      for (const order of imagingOrders || []) {
        if (order.report_entered_at) {
          const tat = (new Date(order.report_entered_at).getTime() - new Date(order.created_at).getTime()) / 60000
          if (tat > 0 && tat < 480) {
            avgImagingTAT += tat
            imagingCount++
          }
        }
      }
      avgImagingTAT = imagingCount > 0 ? Math.round(avgImagingTAT / imagingCount) : 0
      kpis.push({
        kpi_code: 'IMAGING_TAT',
        value: avgImagingTAT,
        status: avgImagingTAT <= 45 ? 'green' : avgImagingTAT <= 60 ? 'yellow' : 'red',
        numerator: avgImagingTAT * imagingCount,
        denominator: imagingCount
      })

      // 8. Triage Wait Time (time at triage stage)
      let avgTriageWait = 0
      let triageCount = 0
      for (const visit of waitTimeData || []) {
        const timeline = visit.journey_timeline as { stages?: { stage: string; wait_time_minutes?: number }[] } | null
        const triageStage = timeline?.stages?.find((s: any) => s.stage === 'at_triage')
        if (triageStage?.wait_time_minutes) {
          avgTriageWait += triageStage.wait_time_minutes
          triageCount++
        }
      }
      avgTriageWait = triageCount > 0 ? Math.round(avgTriageWait / triageCount) : 0
      kpis.push({
        kpi_code: 'TRIAGE_WAIT',
        value: avgTriageWait,
        status: avgTriageWait <= 10 ? 'green' : avgTriageWait <= 15 ? 'yellow' : 'red',
        numerator: avgTriageWait * triageCount,
        denominator: triageCount
      })

      // 9. Doctor Wait Time (time from triage to doctor)
      let avgDoctorWait = 0
      let doctorWaitCount = 0
      for (const visit of waitTimeData || []) {
        const timeline = visit.journey_timeline as { stages?: { stage: string; end_time?: string }[] } | null
        const triageEnd = timeline?.stages?.find((s: any) => s.stage === 'at_triage')?.end_time
        const doctorStart = timeline?.stages?.find((s: any) => s.stage === 'with_doctor')?.end_time
        if (triageEnd && doctorStart) {
          const waitMinutes = (new Date(doctorStart).getTime() - new Date(triageEnd).getTime()) / 60000
          if (waitMinutes > 0 && waitMinutes < 480) {
            avgDoctorWait += waitMinutes
            doctorWaitCount++
          }
        }
      }
      avgDoctorWait = doctorWaitCount > 0 ? Math.round(avgDoctorWait / doctorWaitCount) : 0
      kpis.push({
        kpi_code: 'DOCTOR_WAIT',
        value: avgDoctorWait,
        status: avgDoctorWait <= 20 ? 'green' : avgDoctorWait <= 35 ? 'yellow' : 'red',
        numerator: avgDoctorWait * doctorWaitCount,
        denominator: doctorWaitCount
      })

      // 10. Average Length of Stay
      const { data: completedVisits } = await supabase
        .from('visits')
        .select('created_at, status_updated_at')
        .eq('facility_id', facility.id)
        .gte('visit_date', today)
        .eq('status', 'completed')

      let avgLOS = 0
      let losCount = 0
      for (const visit of completedVisits || []) {
        if (visit.status_updated_at) {
          const los = (new Date(visit.status_updated_at).getTime() - new Date(visit.created_at).getTime()) / 60000
          if (los > 0 && los < 720) { // Cap at 12 hours
            avgLOS += los
            losCount++
          }
        }
      }
      avgLOS = losCount > 0 ? Math.round(avgLOS / losCount) : 0
      kpis.push({
        kpi_code: 'AVG_LOS',
        value: avgLOS,
        status: avgLOS <= 90 ? 'green' : avgLOS <= 120 ? 'yellow' : 'red',
        numerator: avgLOS * losCount,
        denominator: losCount
      })

      // Store KPI values
      for (const kpi of kpis) {
        // Get KPI definition ID
        const { data: kpiDef } = await supabase
          .from('kpi_definitions')
          .select('id')
          .eq('kpi_code', kpi.kpi_code)
          .eq('tenant_id', facility.tenant_id)
          .maybeSingle()

        if (kpiDef?.id) {
          // Upsert KPI value for today
          const { error: upsertError } = await supabase
            .from('kpi_values')
            .upsert({
              kpi_definition_id: kpiDef.id,
              facility_id: facility.id,
              tenant_id: facility.tenant_id,
              value: kpi.value,
              measurement_date: today,
              status: kpi.status,
              numerator: kpi.numerator,
              denominator: kpi.denominator,
              calculation_metadata: {
                calculated_at: new Date().toISOString(),
                data_source: 'calculate-kpis edge function'
              }
            }, {
              onConflict: 'kpi_definition_id,facility_id,measurement_date'
            })

          if (upsertError) {
            console.error(`[KPI] Error upserting ${kpi.kpi_code}:`, upsertError)
          }
        } else {
          console.warn(`[KPI] No definition found for ${kpi.kpi_code} in tenant ${facility.tenant_id}`)
        }
      }

      results.push({ facility: facility.name, kpis })
      console.log(`[KPI] Completed ${kpis.length} KPIs for ${facility.name}`)
    }

    console.log('[KPI] KPI calculation job completed successfully')

    return new Response(
      JSON.stringify({
        success: true,
        message: `Calculated KPIs for ${results.length} facilities`,
        results
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('[KPI] Error in KPI calculation:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
