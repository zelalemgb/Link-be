import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PatientData {
  age: number;
  gender: string;
  chiefComplaint: string;
  vitals: {
    temperature?: number;
    bloodPressure?: string;
    heartRate?: number;
    respiratoryRate?: number;
    oxygenSaturation?: number;
    painScore?: number;
    weight?: number;
  };
  observations: string;
  medicalHistory?: string;
}

const generateClinicalPrompt = (patientData: PatientData) => {
  return `You are an expert clinical AI assistant helping a doctor with differential diagnosis and treatment recommendations. Analyze the following patient data and provide structured recommendations.

Patient Information:
- Age: ${patientData.age} years
- Gender: ${patientData.gender}
- Chief Complaint: ${patientData.chiefComplaint}

Vital Signs:
${patientData.vitals.temperature ? `- Temperature: ${patientData.vitals.temperature}°C` : ''}
${patientData.vitals.bloodPressure ? `- Blood Pressure: ${patientData.vitals.bloodPressure}` : ''}
${patientData.vitals.heartRate ? `- Heart Rate: ${patientData.vitals.heartRate} bpm` : ''}
${patientData.vitals.respiratoryRate ? `- Respiratory Rate: ${patientData.vitals.respiratoryRate}/min` : ''}
${patientData.vitals.oxygenSaturation ? `- Oxygen Saturation: ${patientData.vitals.oxygenSaturation}%` : ''}
${patientData.vitals.painScore ? `- Pain Score: ${patientData.vitals.painScore}/10` : ''}
${patientData.vitals.weight ? `- Weight: ${patientData.vitals.weight}kg` : ''}

Clinical Observations:
${patientData.observations}

Please provide a structured analysis in the following JSON format:
{
  "differentialDiagnosis": [
    {
      "diagnosis": "Most likely diagnosis",
      "probability": "High/Medium/Low",
      "reasoning": "Clinical reasoning for this diagnosis",
      "supportingFindings": ["finding1", "finding2"]
    }
  ],
  "recommendedTests": [
    {
      "test": "Test name",
      "type": "lab/imaging",
      "urgency": "stat/urgent/routine",
      "reasoning": "Why this test is needed"
    }
  ],
  "treatmentOptions": [
    {
      "category": "Immediate/Short-term/Long-term",
      "interventions": [
        {
          "intervention": "Treatment description",
          "type": "medication/procedure/lifestyle",
          "details": "Specific details (dosage, frequency, etc.)",
          "monitoring": "What to monitor"
        }
      ]
    }
  ],
  "redFlags": [
    "Any concerning signs that require immediate attention"
  ],
  "followUp": {
    "timeframe": "When to follow up",
    "criteria": "What to watch for"
  },
  "additionalConsiderations": [
    "Other important clinical considerations"
  ]
}

Important: 
- Base recommendations on evidence-based medicine
- Consider the patient's age and gender in your analysis
- Flag any critical or urgent findings
- Provide conservative recommendations that support clinical decision-making
- Always emphasize that this is AI-generated assistance and requires doctor validation`;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openAIApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const { patientData } = await req.json();
    
    if (!patientData) {
      throw new Error('Patient data is required');
    }

    console.log('Analyzing patient data:', patientData);

    const prompt = generateClinicalPrompt(patientData);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a clinical AI assistant that provides evidence-based diagnostic and treatment recommendations to support healthcare providers. Always provide structured, accurate medical information while emphasizing the need for clinical validation.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI API error:', error);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    console.log('AI response received:', aiResponse);

    // Try to parse the JSON response
    let analysisResult;
    try {
      // Extract JSON from the response if it's wrapped in markdown
      const jsonMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/) || aiResponse.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : aiResponse;
      analysisResult = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError);
      // Return a structured fallback response
      analysisResult = {
        differentialDiagnosis: [{
          diagnosis: "Unable to parse AI response",
          probability: "Unknown",
          reasoning: "AI response could not be parsed properly",
          supportingFindings: []
        }],
        recommendedTests: [],
        treatmentOptions: [],
        redFlags: ["AI analysis failed - manual review required"],
        followUp: {
          timeframe: "As clinically indicated",
          criteria: "Based on clinical judgment"
        },
        additionalConsiderations: ["AI analysis unavailable - rely on clinical assessment"],
        rawResponse: aiResponse
      };
    }

    return new Response(JSON.stringify({
      success: true,
      analysis: analysisResult,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in AI clinical assistant:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      analysis: {
        differentialDiagnosis: [],
        recommendedTests: [],
        treatmentOptions: [],
        redFlags: ["AI analysis unavailable"],
        followUp: {
          timeframe: "As clinically indicated",
          criteria: "Based on clinical judgment"
        },
        additionalConsiderations: ["AI analysis failed - proceed with standard clinical assessment"]
      }
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});