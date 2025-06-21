 const express = require('express');
const path    = require('path');
const app     = express();

const PORT = process.env.PORT || 3000;

// serve everything in /public as static files
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// any unknown route -> return index.html (for future SPA routing)
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`🚀  Atom-Frontend running on http://0.0.0.0:${PORT}`)
);

