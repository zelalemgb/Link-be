import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TreatmentRequestData {
  chiefComplaints: Array<{
    complaint: string;
    onset?: string;
    duration?: string;
    severity?: string;
  }>;
  vitals?: {
    bloodPressure?: string;
    heartRate?: string;
    temperature?: string;
    respiratoryRate?: string;
    oxygenSaturation?: string;
  };
  examinationFindings?: string;
  workingDiagnosis?: string;
  differentialDiagnoses?: string[];
  severity?: string;
  labResults?: Array<{
    test_name: string;
    result_value?: string;
    status: string;
  }>;
  imagingResults?: Array<{
    study_name: string;
    findings?: string;
    status: string;
  }>;
  patientAge?: number;
  patientGender?: string;
  allergies?: string[];
  currentMedications?: string[];
}

function generateTreatmentPrompt(data: TreatmentRequestData): string {
  const isPediatric = data.patientAge && data.patientAge < 18;
  const ageGroup = isPediatric ? 'pediatric' : 'adult';
  
  return `You are an AI clinical assistant specialized in Ethiopian Primary Health Care guidelines and WHO ${ageGroup} treatment protocols. Generate evidence-based treatment recommendations.

PATIENT INFORMATION:
Age: ${data.patientAge || 'Not specified'} years (${ageGroup})
Gender: ${data.patientGender || 'Not specified'}

CHIEF COMPLAINTS:
${data.chiefComplaints.map(cc => 
  `- ${cc.complaint}${cc.onset ? ` (Onset: ${cc.onset})` : ''}${cc.duration ? ` (Duration: ${cc.duration})` : ''}${cc.severity ? ` (Severity: ${cc.severity})` : ''}`
).join('\n')}

VITAL SIGNS:
${data.vitals ? `
- Blood Pressure: ${data.vitals.bloodPressure || 'Not recorded'}
- Heart Rate: ${data.vitals.heartRate || 'Not recorded'}
- Temperature: ${data.vitals.temperature || 'Not recorded'}
- Respiratory Rate: ${data.vitals.respiratoryRate || 'Not recorded'}
- SpO2: ${data.vitals.oxygenSaturation || 'Not recorded'}
` : 'Not recorded'}

EXAMINATION FINDINGS:
${data.examinationFindings || 'Not documented'}

WORKING DIAGNOSIS:
${data.workingDiagnosis || 'Not yet established'}

DIFFERENTIAL DIAGNOSES:
${data.differentialDiagnoses && data.differentialDiagnoses.length > 0 
  ? data.differentialDiagnoses.map(d => `- ${d}`).join('\n')
  : 'None specified'}

SEVERITY ASSESSMENT:
${data.severity || 'Not assessed'}

LAB RESULTS:
${data.labResults && data.labResults.length > 0
  ? data.labResults.map(lab => `- ${lab.test_name}: ${lab.result_value || lab.status}`).join('\n')
  : 'No lab results available'}

IMAGING RESULTS:
${data.imagingResults && data.imagingResults.length > 0
  ? data.imagingResults.map(img => `- ${img.study_name}: ${img.findings || img.status}`).join('\n')
  : 'No imaging results available'}

ALLERGIES:
${data.allergies && data.allergies.length > 0 ? data.allergies.join(', ') : 'None documented'}

CURRENT MEDICATIONS:
${data.currentMedications && data.currentMedications.length > 0 ? data.currentMedications.join(', ') : 'None'}

INSTRUCTIONS:
Generate treatment recommendations following:
1. Ethiopian Essential Medicines List (EEML)
2. WHO ${ageGroup.toUpperCase()} treatment guidelines
3. Ethiopian Primary Health Care Unit (PHCU) protocols
4. Cost-effectiveness for resource-limited settings
5. Pediatric dosing calculations if applicable (age: ${data.patientAge} years)

Consider:
- First-line medications available at PHC level
- Appropriate dosing for ${ageGroup} patient${isPediatric ? ` (weight-based if age ${data.patientAge} years)` : ''}
- Duration of treatment
- Route of administration
- Follow-up requirements
- Red flags requiring referral
- Non-pharmacological interventions
- Patient education points

Return your response in the following JSON format:
{
  "treatmentPlan": {
    "pharmacological": [
      {
        "medicationName": "Generic name",
        "brandNames": ["Available brand names in Ethiopia"],
        "indication": "Specific indication",
        "dosage": "Exact dosage with ${isPediatric ? 'weight-based calculation' : 'adult dosing'}",
        "frequency": "Frequency of administration",
        "route": "Route of administration",
        "duration": "Duration of treatment",
        "specialInstructions": "Timing, with food, etc.",
        "phcGuideline": "Reference to Ethiopian PHC or WHO guideline",
        "alternatives": ["Alternative medications if first-line unavailable or contraindicated"]
      }
    ],
    "nonPharmacological": [
      {
        "intervention": "Intervention name",
        "instructions": "Detailed patient instructions",
        "rationale": "Why this intervention is important",
        "phcGuideline": "Reference guideline"
      }
    ]
  },
  "followUp": {
    "timing": "When to return",
    "monitoringParameters": ["What to monitor"],
    "warningSignsForPatient": ["Red flags patient should watch for"]
  },
  "referralCriteria": {
    "urgentReferral": ["Conditions requiring immediate referral"],
    "routineReferral": ["Conditions requiring specialist consultation"]
  },
  "patientEducation": [
    "Key education points about condition and treatment"
  ],
  "costConsiderations": "Notes on cost-effective alternatives and medication availability",
  "clinicalRationale": "Brief explanation of treatment approach based on presentation and guidelines"
}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const requestData: TreatmentRequestData = await req.json();
    console.log('Treatment recommendation request:', requestData);

    const prompt = generateTreatmentPrompt(requestData);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are an expert clinical AI assistant specializing in Ethiopian Primary Health Care and WHO treatment guidelines. You provide evidence-based, practical treatment recommendations suitable for primary health care settings in Ethiopia. Always consider medication availability, cost-effectiveness, and appropriate dosing for the patient age group.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', response.status, errorText);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('OpenAI response received');

    let recommendations;
    try {
      const content = data.choices[0].message.content;
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || content.match(/(\{[\s\S]*\})/);
      const jsonString = jsonMatch ? jsonMatch[1] : content;
      recommendations = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      throw new Error('Failed to parse AI response as JSON');
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        recommendations 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('Error in treatment-recommendations function:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error occurred' 
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
