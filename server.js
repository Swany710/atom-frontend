const express = require('express');
const path    = require('path');
const app     = express();

const PORT = process.env.PORT || 3000;

// Runtime config — injected from Railway env vars
app.get('/api/config', (_req, res) => {
  res.json({
    apiBaseUrl: process.env.API_BASE_URL || 'https://atom-backend-production-8a1e.up.railway.app/api/v1',
    apiKey:     process.env.API_KEY || '',
  });
});

// Serve everything in /public as static files
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Any unknown route -> return index.html (SPA fallback)
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`🚀  Atom-Frontend running on http://0.0.0.0:${PORT}`)
);
