import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DiagnosisRequest {
  patientAge: number;
  patientGender: string;
  chiefComplaints: Array<{
    complaint: string;
    onset: string;
    duration: string;
    severity: string;
    character: string;
  }>;
  associatedSymptoms: string[];
  reviewOfSystems: string[];
  physicalExam: {
    generalAppearance: string;
    vitalsAssessment: string;
    systemicFindings: string[];
    focusedExam: string;
    redFlags: string[];
  };
  vitals: {
    temperature?: number;
    bloodPressure?: string;
    heartRate?: number;
    respiratoryRate?: number;
    oxygenSaturation?: number;
    painScore?: number;
  };
}

const generateDiagnosisPrompt = (data: DiagnosisRequest) => {
  const complaints = data.chiefComplaints.map(cc => 
    `${cc.complaint} (onset: ${cc.onset}, duration: ${cc.duration}, severity: ${cc.severity})`
  ).join('; ');
  
  return `You are an expert diagnostician helping a physician formulate working diagnoses. Analyze the clinical data and provide evidence-based diagnostic recommendations.

PATIENT DATA:
Age: ${data.patientAge} years
Gender: ${data.patientGender}

CHIEF COMPLAINTS:
${complaints}

ASSOCIATED SYMPTOMS:
${data.associatedSymptoms.join(', ') || 'None reported'}

REVIEW OF SYSTEMS:
${data.reviewOfSystems.join(', ') || 'Not documented'}

PHYSICAL EXAMINATION:
General Appearance: ${data.physicalExam.generalAppearance || 'Not documented'}
Vitals Assessment: ${data.physicalExam.vitalsAssessment || 'Not documented'}
Systemic Findings: ${data.physicalExam.systemicFindings.join(', ') || 'None'}
Focused Exam: ${data.physicalExam.focusedExam || 'Not documented'}
Red Flags: ${data.physicalExam.redFlags.join(', ') || 'None'}

VITAL SIGNS:
${data.vitals.temperature ? `Temperature: ${data.vitals.temperature}°C` : ''}
${data.vitals.bloodPressure ? `Blood Pressure: ${data.vitals.bloodPressure}` : ''}
${data.vitals.heartRate ? `Heart Rate: ${data.vitals.heartRate} bpm` : ''}
${data.vitals.respiratoryRate ? `Respiratory Rate: ${data.vitals.respiratoryRate}/min` : ''}
${data.vitals.oxygenSaturation ? `SpO2: ${data.vitals.oxygenSaturation}%` : ''}
${data.vitals.painScore ? `Pain Score: ${data.vitals.painScore}/10` : ''}

Provide your diagnostic recommendations in the following JSON format:
{
  "workingDiagnosis": "Most likely primary diagnosis based on clinical presentation",
  "confidence": "High/Moderate/Low",
  "clinicalReasoning": "Brief explanation of why this is the primary diagnosis (2-3 sentences)",
  "keyFindings": ["Finding 1", "Finding 2", "Finding 3"],
  "differentialDiagnoses": [
    {
      "diagnosis": "Alternative diagnosis 1",
      "likelihood": "High/Moderate/Low",
      "distinguishingFeatures": "What would distinguish this from the working diagnosis"
    },
    {
      "diagnosis": "Alternative diagnosis 2",
      "likelihood": "High/Moderate/Low",
      "distinguishingFeatures": "What would distinguish this from the working diagnosis"
    },
    {
      "diagnosis": "Alternative diagnosis 3",
      "likelihood": "High/Moderate/Low",
      "distinguishingFeatures": "What would distinguish this from the working diagnosis"
    }
  ],
  "nextSteps": [
    "Recommended next step 1",
    "Recommended next step 2"
  ],
  "redFlagAssessment": "Assessment of any concerning findings that require immediate attention or None identified"
}

GUIDELINES:
- Base recommendations on current evidence-based medicine and clinical guidelines
- Consider patient age and gender in differential diagnosis
- Prioritize common diagnoses but include serious conditions that must not be missed
- Be concise and clinically relevant
- If data is insufficient, note this in the clinical reasoning`;
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

    const requestData: DiagnosisRequest = await req.json();
    
    console.log('Generating diagnosis recommendations for patient:', {
      age: requestData.patientAge,
      gender: requestData.patientGender,
      complaints: requestData.chiefComplaints.length
    });

    const prompt = generateDiagnosisPrompt(requestData);

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
            content: 'You are an expert clinical diagnostician providing evidence-based diagnostic recommendations. Always structure your response as valid JSON and emphasize that recommendations require physician validation.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI API error:', error);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    console.log('Diagnosis recommendations received');

    let recommendations;
    try {
      const jsonMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/) || aiResponse.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : aiResponse;
      recommendations = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      throw new Error('Failed to parse AI recommendations');
    }

    return new Response(JSON.stringify({
      success: true,
      recommendations,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error generating diagnosis recommendations:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
