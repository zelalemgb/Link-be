import express from 'express';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { requireUser } from '../middleware/auth';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Function to call the python service
async function callMedGemma(prompt: string, imageBuffer?: Buffer, filename?: string) {
    const form = new FormData();
    form.append('prompt', prompt);
    if (imageBuffer && filename) {
        form.append('image', imageBuffer, filename);
    }

    try {
        const response = await axios.post('http://127.0.0.1:8000/predict', form, {
            headers: {
                ...form.getHeaders(),
            },
        });
        return response.data;
    } catch (error: any) {
        console.error('Error calling MedGemma:', error);
        // Debugging: return detailed error
        throw new Error(`Failed to analyze data: ${error.message} - ${error.response?.data?.detail || ''}`);
    }
}

router.post('/analyze', requireUser, upload.single('image'), async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        console.log(`Processing AI analysis request for user ${req.user?.profileId}`);
        const startTime = Date.now();

        const result = await callMedGemma(prompt, req.file?.buffer, req.file?.originalname);

        const duration = Date.now() - startTime;
        console.log(`AI Analysis completed in ${duration}ms`);

        res.json(result);
    } catch (error: any) {
        console.error('AI Analysis Route Error:', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

export default router;
