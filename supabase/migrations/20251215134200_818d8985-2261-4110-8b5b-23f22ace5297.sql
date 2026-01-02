-- Step 1: Delete all payment-related data
DELETE FROM payment_transactions;
DELETE FROM payment_line_items;
DELETE FROM payments WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';