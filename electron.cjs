const { app } = require('electron');
const path = require('node:path');

// Electron will run dist/main/main.js in production.
// In dev we run the compiled output from tsc in dist/main.
require(path.join(__dirname, 'dist/main/main.js'));
