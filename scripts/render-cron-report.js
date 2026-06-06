const reportType = process.argv[2];
const controlApiUrl = process.env.CONTROL_API_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/reports/send';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY;

if (!reportType) {
  throw new Error('Missing report type. Usage: node scripts/render-cron-report.js <reportType>');
}

if (!controlApiKey) {
  throw new Error('SEVEN_CONTROL_API_KEY is not set.');
}

const response = await fetch(controlApiUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-seven-control-key': controlApiKey,
  },
  body: JSON.stringify({ reportType }),
});

const responseText = await response.text();
if (!response.ok) {
  throw new Error(`Report push failed: ${response.status} ${responseText}`);
}

console.log(`Report push succeeded for ${reportType}: ${responseText}`);
