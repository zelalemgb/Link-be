import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DiagnosticRequestData {
  patientAge: number;
  patientGender: string;
  chiefComplaints: string[];
  hpiData: {
    associatedSymptoms: string[];
    duration: string;
    severity: string;
  };
  vitalSigns: {
    temperature?: number;
    bloodPressure?: string;
    heartRate?: number;
    respiratoryRate?: number;
    oxygenSaturation?: number;
    painScore?: number;
  };
  examFindings: string[];
  workingDiagnosis?: string;
  differentialDiagnoses?: string[];
  urgencyLevel?: string;
}

const generateDiagnosticPrompt = (data: DiagnosticRequestData) => {
  return `You are an expert clinical AI assistant with deep knowledge of Ethiopian Primary Health Care (PHC) guidelines, WHO protocols, and evidence-based medicine. Analyze the following patient presentation and recommend appropriate diagnostic imaging and laboratory tests.

PATIENT PRESENTATION:
Age: ${data.patientAge} years
Gender: ${data.patientGender}
Chief Complaints: ${data.chiefComplaints.join(', ')}
Duration: ${data.hpiData.duration || 'Not specified'}
Severity: ${data.hpiData.severity || 'Not specified'}
Associated Symptoms: ${data.hpiData.associatedSymptoms.join(', ') || 'None reported'}

VITAL SIGNS:
${data.vitalSigns.temperature ? `Temperature: ${data.vitalSigns.temperature}°C` : ''}
${data.vitalSigns.bloodPressure ? `Blood Pressure: ${data.vitalSigns.bloodPressure}` : ''}
${data.vitalSigns.heartRate ? `Heart Rate: ${data.vitalSigns.heartRate} bpm` : ''}
${data.vitalSigns.respiratoryRate ? `Respiratory Rate: ${data.vitalSigns.respiratoryRate}/min` : ''}
${data.vitalSigns.oxygenSaturation ? `Oxygen Saturation: ${data.vitalSigns.oxygenSaturation}%` : ''}
${data.vitalSigns.painScore ? `Pain Score: ${data.vitalSigns.painScore}/10` : ''}

PHYSICAL EXAMINATION FINDINGS:
${data.examFindings.join(', ') || 'No specific findings documented'}

${data.workingDiagnosis ? `WORKING DIAGNOSIS: ${data.workingDiagnosis}` : ''}
${data.differentialDiagnoses?.length ? `DIFFERENTIAL DIAGNOSES: ${data.differentialDiagnoses.join(', ')}` : ''}
${data.urgencyLevel ? `URGENCY LEVEL: ${data.urgencyLevel}` : ''}

INSTRUCTIONS:
Based on Ethiopian PHC guidelines, WHO protocols, and evidence-based medicine, recommend appropriate diagnostic tests. Consider:
1. Cost-effectiveness and availability in Ethiopian PHC settings
2. Clinical utility and impact on management decisions
3. Urgency based on presentation
4. Age and gender-specific considerations
5. Rule out dangerous conditions (red flags)

Provide your response in STRICT JSON format with this exact structure:
{
  "imagingRecommendations": [
    {
      "studyName": "Exact name of imaging study",
      "bodyPart": "Anatomical area",
      "urgency": "stat/urgent/routine",
      "clinicalIndication": "Why this test is needed",
      "expectedFindings": "What we're looking for",
      "phcGuideline": "Reference to Ethiopian PHC or WHO guideline"
    }
  ],
  "labRecommendations": [
    {
      "testName": "Exact name of lab test",
      "testCode": "Standard test code if applicable",
      "urgency": "stat/urgent/routine",
      "clinicalIndication": "Why this test is needed",
      "expectedAbnormalities": "What we're evaluating",
      "phcGuideline": "Reference to Ethiopian PHC or WHO guideline"
    }
  ],
  "priorityOrder": ["test1", "test2", "test3"],
  "rationale": "Brief clinical rationale for the recommended workup",
  "redFlags": ["Any critical findings requiring immediate attention"],
  "costConsiderations": "Brief note on cost-effectiveness in PHC setting"
}

IMPORTANT: 
- Return ONLY valid JSON, no markdown formatting
- Base recommendations on Ethiopian PHC capacity and guidelines
- Prioritize tests that will change management
- Consider resource constraints in primary care settings
- Flag any emergency/urgent investigations`;
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

    const requestData: DiagnosticRequestData = await req.json();
    
    if (!requestData.chiefComplaints || requestData.chiefComplaints.length === 0) {
      throw new Error('Chief complaints are required');
    }

    console.log('Generating diagnostic recommendations for:', requestData);

    const prompt = generateDiagnosticPrompt(requestData);

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
            content: 'You are an expert clinical AI assistant specializing in Ethiopian Primary Health Care guidelines and evidence-based diagnostic recommendations. Always provide structured, accurate medical information in valid JSON format.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
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

    // Parse the JSON response
    let recommendations;
    try {
      // Extract JSON from the response if it's wrapped in markdown
      const jsonMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/) || aiResponse.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : aiResponse;
      recommendations = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError);
      // Return a structured fallback response
      recommendations = {
        imagingRecommendations: [],
        labRecommendations: [],
        priorityOrder: [],
        rationale: "AI response parsing failed - please review manually",
        redFlags: ["AI analysis unavailable - use clinical judgment"],
        costConsiderations: "Standard PHC protocols apply",
        rawResponse: aiResponse
      };
    }

    return new Response(JSON.stringify({
      success: true,
      recommendations,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in diagnostic recommendations:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      recommendations: {
        imagingRecommendations: [],
        labRecommendations: [],
        priorityOrder: [],
        rationale: "AI analysis unavailable",
        redFlags: [],
        costConsiderations: "Standard PHC protocols apply"
      }
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
