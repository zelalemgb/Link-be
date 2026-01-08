#!/bin/bash
# Quick test script to simulate patient registration API call

echo "Testing patient registration endpoint..."
echo ""

# Make a test API call to the backend
curl -X POST http://localhost:4000/api/patients/register-intake \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{
    "firstName": "Test",
    "middleName": "Patient",
    "lastName": "Registration",
    "sex": "M",
    "age": 30,
    "dateOfBirth": null,
    "phone": "+251872345709",
    "fayidaId": null,
    "region": "",
    "woredaSubcity": "",
    "ketenaGott": "",
    "kebele": "",
    "houseNumber": "",
    "visitType": "New",
    "residence": "",
    "occupation": "",
    "intakeTimestamp": "2026-01-02T17:14:00",
    "intakePatientId": "20260102-TEST",
    "consultationPaymentType": "paying",
    "programId": "",
    "creditorId": "",
    "insuranceProviderId": "",
    "insurancePolicyNumber": ""
  }' \
  -v 2>&1 | tail -50

echo ""
echo "Check the response above for error details"
